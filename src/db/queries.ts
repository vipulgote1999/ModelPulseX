import type {
  BenchmarkResult,
  BenchmarkType,
  ModelMetadata,
  ProviderName,
} from "../types";

export async function ensureProvider(
  db: D1Database,
  name: ProviderName,
): Promise<number> {
  // Fast path: try insert ignore then select (2 round trips max, no race)
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT OR IGNORE INTO providers (name,type,enabled,created_at) VALUES (?,?,1,?)",
    )
    .bind(name, name, now)
    .run();
  const row = await db
    .prepare("SELECT id FROM providers WHERE name=?")
    .bind(name)
    .first<{ id: number }>();
  return row!.id;
}

export async function ensureProvidersBatch(
  db: D1Database,
  names: ProviderName[],
): Promise<Map<string, number>> {
  if (names.length === 0) return new Map();
  const now = new Date().toISOString();
  const stmts = names.map((n) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO providers (name,type,enabled,created_at) VALUES (?,?,1,?)",
      )
      .bind(n, n, now),
  );
  // D1 batch is atomic and single roundtrip for writes
  await db.batch(stmts);
  const placeholders = names.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT id, name FROM providers WHERE name IN (${placeholders})`)
    .bind(...names)
    .all<{ id: number; name: string }>();
  const m = new Map<string, number>();
  for (const r of rows.results ?? []) m.set(r.name, r.id);
  return m;
}

const DISABLED_PROVIDER_DEFAULT = new Set<string>([
  "speka",
  "nexaapi",
  "ninerouter",
]);

export async function upsertModel(
  db: D1Database,
  providerId: number,
  meta: ModelMetadata,
  nowIso: string,
): Promise<number> {
  // Single-statement UPSERT — no pre-select, no N+1, correct under concurrency
  // benchmark_enabled: preserve admin toggle on update; set sensible default on insert (is_free ? 1 : 0) but force 0 for $1-credit providers
  const capsJson = JSON.stringify(meta.capabilities);
  // Resolve provider name for default-disabled check (best-effort, ignore if lookup fails)
  let defaultEnabled = meta.is_free ? 1 : 0;
  try {
    const prov = await db
      .prepare("SELECT name FROM providers WHERE id=?")
      .bind(providerId)
      .first<{ name: string }>();
    if (prov && DISABLED_PROVIDER_DEFAULT.has(prov.name)) defaultEnabled = 0;
    if (prov?.name === "groq" && meta.provider_model_id.startsWith("whisper"))
      defaultEnabled = 0;
  } catch (e) {
    console.warn("provider lookup failed for defaultEnabled", e);
  }
  const r = await db
    .prepare(
      `INSERT INTO models (provider_id, provider_model_id, name, display_name, is_free, free_status, context_length, capabilities, input_price, output_price, first_seen, last_seen, active, benchmark_enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
       ON CONFLICT(provider_id, provider_model_id) DO UPDATE SET
         name=excluded.name,
         display_name=excluded.display_name,
         is_free=excluded.is_free,
         free_status=excluded.free_status,
         context_length=excluded.context_length,
         capabilities=excluded.capabilities,
         input_price=excluded.input_price,
         output_price=excluded.output_price,
         last_seen=excluded.last_seen,
         active=1,
         benchmark_enabled=CASE WHEN excluded.is_free=0 THEN 0 ELSE models.benchmark_enabled END
       RETURNING id`,
    )
    .bind(
      providerId,
      meta.provider_model_id,
      meta.display_name,
      meta.display_name,
      meta.is_free ? 1 : 0,
      meta.free_status,
      meta.context_length,
      capsJson,
      meta.input_price,
      meta.output_price,
      nowIso,
      nowIso,
      defaultEnabled,
    )
    .first<{ id: number }>()
    .catch(async () => {
      // Fallback when benchmark_enabled column not yet migrated (pre-0007)
      const rr = await db
        .prepare(
          `INSERT INTO models (provider_id, provider_model_id, name, display_name, is_free, free_status, context_length, capabilities, input_price, output_price, first_seen, last_seen, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
         ON CONFLICT(provider_id, provider_model_id) DO UPDATE SET
           name=excluded.name,
           display_name=excluded.display_name,
           is_free=excluded.is_free,
           free_status=excluded.free_status,
           context_length=excluded.context_length,
           capabilities=excluded.capabilities,
           input_price=excluded.input_price,
           output_price=excluded.output_price,
           last_seen=excluded.last_seen,
           active=1
         RETURNING id`,
        )
        .bind(
          providerId,
          meta.provider_model_id,
          meta.display_name,
          meta.display_name,
          meta.is_free ? 1 : 0,
          meta.free_status,
          meta.context_length,
          capsJson,
          meta.input_price,
          meta.output_price,
          nowIso,
          nowIso,
        )
        .first<{ id: number }>();
      return rr;
    });
  if (r?.id) return r.id;
  // Fallback for D1 without RETURNING support (older) — select
  const fetched = await db
    .prepare(
      "SELECT id FROM models WHERE provider_id=? AND provider_model_id=?",
    )
    .bind(providerId, meta.provider_model_id)
    .first<{ id: number }>();
  return fetched!.id;
}

export async function upsertModelsBatch(
  db: D1Database,
  providerId: number,
  metas: ModelMetadata[],
  nowIso: string,
): Promise<number[]> {
  if (metas.length === 0) return [];
  // Batch UPSERT via single roundtrip per chunk (max 50 to stay under D1 limits)
  // Preserve benchmark_enabled on conflict so admin toggle is not overwritten by discovery
  let providerName: string | null = null;
  try {
    const prov = await db
      .prepare("SELECT name FROM providers WHERE id=?")
      .bind(providerId)
      .first<{ name: string }>();
    providerName = prov?.name ?? null;
  } catch (e) {
    console.warn("provider lookup failed for batch", e);
  }
  const CHUNK = 50;
  const ids: number[] = [];
  for (let i = 0; i < metas.length; i += CHUNK) {
    const chunk = metas.slice(i, i + CHUNK);
    const stmts = chunk.map((meta) => {
      const capsJson = JSON.stringify(meta.capabilities);
      let defaultEnabled = meta.is_free ? 1 : 0;
      if (providerName && DISABLED_PROVIDER_DEFAULT.has(providerName))
        defaultEnabled = 0;
      if (
        providerName === "groq" &&
        meta.provider_model_id.startsWith("whisper")
      )
        defaultEnabled = 0;
      // Try with benchmark_enabled; fallback without if column missing
      try {
        return db
          .prepare(
            `INSERT INTO models (provider_id, provider_model_id, name, display_name, is_free, free_status, context_length, capabilities, input_price, output_price, first_seen, last_seen, active, benchmark_enabled)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
             ON CONFLICT(provider_id, provider_model_id) DO UPDATE SET
               name=excluded.name, display_name=excluded.display_name, is_free=excluded.is_free, free_status=excluded.free_status,
               context_length=excluded.context_length, capabilities=excluded.capabilities, input_price=excluded.input_price, output_price=excluded.output_price,
               last_seen=excluded.last_seen, active=1,
               benchmark_enabled=CASE WHEN excluded.is_free=0 THEN 0 ELSE models.benchmark_enabled END`,
          )
          .bind(
            providerId,
            meta.provider_model_id,
            meta.display_name,
            meta.display_name,
            meta.is_free ? 1 : 0,
            meta.free_status,
            meta.context_length,
            capsJson,
            meta.input_price,
            meta.output_price,
            nowIso,
            nowIso,
            defaultEnabled,
          );
      } catch {
        return db
          .prepare(
            `INSERT INTO models (provider_id, provider_model_id, name, display_name, is_free, free_status, context_length, capabilities, input_price, output_price, first_seen, last_seen, active)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
             ON CONFLICT(provider_id, provider_model_id) DO UPDATE SET
               name=excluded.name, display_name=excluded.display_name, is_free=excluded.is_free, free_status=excluded.free_status,
               context_length=excluded.context_length, capabilities=excluded.capabilities, input_price=excluded.input_price, output_price=excluded.output_price,
               last_seen=excluded.last_seen, active=1`,
          )
          .bind(
            providerId,
            meta.provider_model_id,
            meta.display_name,
            meta.display_name,
            meta.is_free ? 1 : 0,
            meta.free_status,
            meta.context_length,
            capsJson,
            meta.input_price,
            meta.output_price,
            nowIso,
            nowIso,
          );
      }
    });
    // Execute with fallback for missing column: try batch with column, on error retry without
    try {
      await db.batch(stmts);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("benchmark_enabled") || msg.includes("no such column")) {
        const fallbackStmts = chunk.map((meta) => {
          const capsJson = JSON.stringify(meta.capabilities);
          return db
            .prepare(
              `INSERT INTO models (provider_id, provider_model_id, name, display_name, is_free, free_status, context_length, capabilities, input_price, output_price, first_seen, last_seen, active)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
             ON CONFLICT(provider_id, provider_model_id) DO UPDATE SET
               name=excluded.name, display_name=excluded.display_name, is_free=excluded.is_free, free_status=excluded.free_status,
               context_length=excluded.context_length, capabilities=excluded.capabilities, input_price=excluded.input_price, output_price=excluded.output_price,
               last_seen=excluded.last_seen, active=1`,
            )
            .bind(
              providerId,
              meta.provider_model_id,
              meta.display_name,
              meta.display_name,
              meta.is_free ? 1 : 0,
              meta.free_status,
              meta.context_length,
              capsJson,
              meta.input_price,
              meta.output_price,
              nowIso,
              nowIso,
            );
        });
        await db.batch(fallbackStmts);
      } else throw e;
    }
    // fetch ids for this chunk
    const placeholders = chunk.map(() => "?").join(",");
    const idsChunk = chunk.map((m) => m.provider_model_id);
    const rows = await db
      .prepare(
        `SELECT id, provider_model_id FROM models WHERE provider_id=? AND provider_model_id IN (${placeholders})`,
      )
      .bind(providerId, ...idsChunk)
      .all<{ id: number; provider_model_id: string }>();
    const map = new Map<string, number>();
    for (const r of rows.results ?? []) map.set(r.provider_model_id, r.id);
    for (const m of chunk) ids.push(map.get(m.provider_model_id)!);
  }
  return ids;
}

export async function markMissingInactive(
  db: D1Database,
  providerId: number,
  seenIds: Set<string>,
  nowIso: string,
) {
  if (seenIds.size === 0) {
    // No models discovered for this provider — deactivate all active as PREVIOUSLY_FREE where applicable
    await db
      .prepare(
        `UPDATE models SET active=0, free_status=CASE WHEN free_status='FREE' THEN 'PREVIOUSLY_FREE' ELSE free_status END, last_seen=? WHERE provider_id=? AND active=1`,
      )
      .bind(nowIso, providerId)
      .run();
    return;
  }
  // Single-statement bulk deactivate — no N+1 loop, no per-row fetch
  const placeholders = Array.from(seenIds)
    .map(() => "?")
    .join(",");
  const ids = Array.from(seenIds);
  await db
    .prepare(
      `UPDATE models SET active=0, free_status=CASE WHEN free_status='FREE' THEN 'PREVIOUSLY_FREE' ELSE free_status END, last_seen=? WHERE provider_id=? AND active=1 AND provider_model_id NOT IN (${placeholders})`,
    )
    .bind(nowIso, providerId, ...ids)
    .run();
}

export async function insertBenchmarkRun(
  db: D1Database,
  modelId: number,
  r: BenchmarkResult,
): Promise<number> {
  const ins = await db
    .prepare(
      `INSERT INTO benchmark_runs (model_id, benchmark_type, started_at, first_token_at, completed_at, input_tokens, output_tokens, ttft_ms, generation_ms, tps, itl_ms, chunk_count, status, error_type, http_status, provider, model, token_estimation_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      modelId,
      r.benchmark_type,
      r.request_started_at,
      r.first_token_at,
      r.request_completed_at,
      r.input_tokens,
      r.output_tokens,
      r.ttft_ms,
      r.generation_ms,
      r.tps,
      r.itl_ms,
      r.chunk_count,
      r.status,
      r.error_type ? r.error_type.slice(0, 500) : null,
      r.http_status,
      r.provider,
      r.model,
      r.token_estimation_method,
    )
    .run();
  return ins.meta.last_row_id as number;
}

export function parseRange(
  range: string,
): { hours: number; sinceIso: string } | null {
  const map: Record<string, number> = {
    "1h": 1,
    "24h": 24,
    "3d": 72,
    "7d": 168,
  };
  const h = map[range];
  if (!h) return null;
  const since = new Date(Date.now() - h * 3600 * 1000).toISOString();
  return { hours: h, sinceIso: since };
}

export async function getModels(
  db: D1Database,
  opts: {
    provider?: string;
    freeOnly?: boolean;
    includeInactive?: boolean;
  } = {},
) {
  let sql = `SELECT m.*, p.name as provider_name FROM models m JOIN providers p ON p.id=m.provider_id`;
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (opts.provider) {
    conds.push("p.name=?");
    binds.push(opts.provider);
  }
  if (opts.freeOnly) {
    conds.push("m.free_status='FREE' AND m.active=1");
  } else if (!opts.includeInactive) {
    // include active + PREVIOUSLY_FREE for 7d retention display
    // caller may add includeInactive
  }
  if (conds.length) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY m.provider_id, m.display_name";
  return db
    .prepare(sql)
    .bind(...binds)
    .all();
}

export async function computeHourlyAggregates(
  db: D1Database,
  forHourStart: string,
) {
  const hourStart = forHourStart;
  const hourEnd = new Date(
    new Date(hourStart).getTime() + 3600 * 1000,
  ).toISOString();
  const rows = await db
    .prepare(
      `SELECT model_id, benchmark_type,
        GROUP_CONCAT(tps) as tpss,
        GROUP_CONCAT(ttft_ms) as ttfts,
        GROUP_CONCAT(itl_ms) as itls,
        COUNT(*) as cnt,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as success
     FROM benchmark_runs
     WHERE started_at >= ? AND started_at < ?
     GROUP BY model_id, benchmark_type`,
    )
    .bind(hourStart, hourEnd)
    .all<{
      model_id: number;
      benchmark_type: BenchmarkType;
      tpss: string | null;
      ttfts: string | null;
      itls: string | null;
      cnt: number;
      success: number;
    }>();

  if (!rows.results || rows.results.length === 0) return;
  const stmts: ReturnType<D1Database["prepare"]>[] = [];
  for (const r of rows.results ?? []) {
    const tpss = (r.tpss ?? "")
      .split(",")
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0);
    const ttfts = (r.ttfts ?? "")
      .split(",")
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0);
    const itls = (r.itls ?? "")
      .split(",")
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0);
    const avg_tps = tpss.length
      ? tpss.reduce((a, b) => a + b, 0) / tpss.length
      : null;
    const median_tps = percentile(tpss, 50);
    const p90_tps = percentile(tpss, 90);
    const p95_tps = percentile(tpss, 95);
    const avg_ttft = ttfts.length
      ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length
      : null;
    const median_ttft = percentile(ttfts, 50);
    const p90_ttft = percentile(ttfts, 90);
    const p95_ttft = percentile(ttfts, 95);
    const median_itl = percentile(itls, 50);
    const p90_itl = percentile(itls, 90);
    const success_rate = r.cnt ? r.success / r.cnt : 0;
    const uptime = success_rate; // same as success_rate — uptime is success ratio for the hour
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO hourly_model_stats (model_id, hour_start, benchmark_type, avg_tps, median_tps, p90_tps, p95_tps, avg_ttft, median_ttft, p90_ttft, p95_ttft, median_itl, p90_itl, success_rate, error_rate, uptime, request_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          r.model_id,
          hourStart,
          r.benchmark_type,
          avg_tps,
          median_tps,
          p90_tps,
          p95_tps,
          avg_ttft,
          median_ttft,
          p90_ttft,
          p95_ttft,
          median_itl,
          p90_itl,
          success_rate,
          1 - success_rate,
          uptime,
          r.cnt,
        ),
    );
  }
  // Single batch write — one roundtrip, atomic per hour
  for (let i = 0; i < stmts.length; i += 50) {
    const chunk = stmts.slice(i, i + 50);
    await db.batch(chunk);
  }
}

export function truncateToTenMin(iso: string): string {
  const d = new Date(iso);
  const mins = Math.floor(d.getUTCMinutes() / 10) * 10;
  d.setUTCMinutes(mins, 0, 0);
  return d.toISOString();
}

export async function computeTenminAggregates(
  db: D1Database,
  forBucketStart: string,
) {
  const bucketStart = truncateToTenMin(forBucketStart);
  const bucketEnd = new Date(new Date(bucketStart).getTime() + 10 * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      `SELECT model_id, benchmark_type,
        GROUP_CONCAT(tps) as tpss,
        GROUP_CONCAT(ttft_ms) as ttfts,
        GROUP_CONCAT(itl_ms) as itls,
        COUNT(*) as cnt,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as success
     FROM benchmark_runs
     WHERE started_at >= ? AND started_at < ?
     GROUP BY model_id, benchmark_type`,
    )
    .bind(bucketStart, bucketEnd)
    .all<{
      model_id: number;
      benchmark_type: BenchmarkType;
      tpss: string | null;
      ttfts: string | null;
      itls: string | null;
      cnt: number;
      success: number;
    }>();

  if (!rows.results || rows.results.length === 0) return;
  const stmts: ReturnType<D1Database["prepare"]>[] = [];
  for (const r of rows.results ?? []) {
    const tpss = (r.tpss ?? "")
      .split(",")
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0);
    const ttfts = (r.ttfts ?? "")
      .split(",")
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0);
    const itls = (r.itls ?? "")
      .split(",")
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0);
    const avg_tps = tpss.length
      ? tpss.reduce((a, b) => a + b, 0) / tpss.length
      : null;
    const median_tps = percentile(tpss, 50);
    const p90_tps = percentile(tpss, 90);
    const p95_tps = percentile(tpss, 95);
    const avg_ttft = ttfts.length
      ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length
      : null;
    const median_ttft = percentile(ttfts, 50);
    const p90_ttft = percentile(ttfts, 90);
    const p95_ttft = percentile(ttfts, 95);
    const median_itl = percentile(itls, 50);
    const p90_itl = percentile(itls, 90);
    const success_rate = r.cnt ? r.success / r.cnt : 0;
    const uptime = success_rate;
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO tenmin_model_stats (model_id, bucket_start, benchmark_type, avg_tps, median_tps, p90_tps, p95_tps, avg_ttft, median_ttft, p90_ttft, p95_ttft, median_itl, p90_itl, success_rate, error_rate, uptime, request_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          r.model_id,
          bucketStart,
          r.benchmark_type,
          avg_tps,
          median_tps,
          p90_tps,
          p95_tps,
          avg_ttft,
          median_ttft,
          p90_ttft,
          p95_ttft,
          median_itl,
          p90_itl,
          success_rate,
          1 - success_rate,
          uptime,
          r.cnt,
        ),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) {
    const chunk = stmts.slice(i, i + 50);
    await db.batch(chunk);
  }
}

function percentile(vals: number[], p: number): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, Math.min(idx, s.length - 1))] ?? null;
}

export async function cleanupRetention(
  db: D1Database,
  rawDays = 7,
  hourlyDays = 30,
  tenminDays = 30,
) {
  const rawCut = new Date(Date.now() - rawDays * 86400 * 1000).toISOString();
  const hourlyCut = new Date(
    Date.now() - hourlyDays * 86400 * 1000,
  ).toISOString();
  const tenminCut = new Date(
    Date.now() - tenminDays * 86400 * 1000,
  ).toISOString();
  // Batch deletes — tenmin is best-effort if table not yet migrated
  const stmts: ReturnType<D1Database["prepare"]>[] = [
    db.prepare("DELETE FROM benchmark_runs WHERE started_at < ?").bind(rawCut),
    db.prepare("DELETE FROM hourly_model_stats WHERE hour_start < ?").bind(hourlyCut),
    db.prepare("DELETE FROM tenmin_model_stats WHERE bucket_start < ?").bind(tenminCut),
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("tenmin_model_stats") || msg.includes("no such table")) {
      await db.batch(stmts.slice(0, 2));
    } else throw e;
  }
}
