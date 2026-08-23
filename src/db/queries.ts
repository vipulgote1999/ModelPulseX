import type { BenchmarkResult, BenchmarkType, FreeStatus, ModelMetadata, ProviderName } from "../types";

export async function ensureProvider(db: D1Database, name: ProviderName): Promise<number> {
  const existing = await db.prepare("SELECT id FROM providers WHERE name=?").bind(name).first<{ id: number }>();
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const r = await db
    .prepare("INSERT INTO providers (name,type,enabled,created_at) VALUES (?,?,1,?)")
    .bind(name, name, now)
    .run();
  return r.meta.last_row_id as number;
}

export async function upsertModel(db: D1Database, providerId: number, meta: ModelMetadata, nowIso: string): Promise<number> {
  const existing = await db
    .prepare("SELECT id, first_seen, active, free_status FROM models WHERE provider_id=? AND provider_model_id=?")
    .bind(providerId, meta.provider_model_id)
    .first<{ id: number; first_seen: string; active: number; free_status: string }>();
  const capsJson = JSON.stringify(meta.capabilities);
  if (existing) {
    await db
      .prepare(
        `UPDATE models SET name=?, display_name=?, is_free=?, free_status=?, context_length=?, capabilities=?, input_price=?, output_price=?, last_seen=?, active=1 WHERE id=?`,
      )
      .bind(meta.display_name, meta.display_name, meta.is_free ? 1 : 0, meta.free_status, meta.context_length, capsJson, meta.input_price, meta.output_price, nowIso, existing.id)
      .run();
    return existing.id;
  } else {
    const r = await db
      .prepare(
        `INSERT INTO models (provider_id, provider_model_id, name, display_name, is_free, free_status, context_length, capabilities, input_price, output_price, first_seen, last_seen, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        1,
      )
      .run();
    return r.meta.last_row_id as number;
  }
}

export async function markMissingInactive(db: D1Database, providerId: number, seenIds: Set<string>, nowIso: string) {
  const all = await db
    .prepare("SELECT id, provider_model_id, free_status FROM models WHERE provider_id=? AND active=1")
    .bind(providerId)
    .all<{ id: number; provider_model_id: string; free_status: string }>();
  for (const row of all.results ?? []) {
    if (!seenIds.has(row.provider_model_id)) {
      // Transition FREE -> PREVIOUSLY_FREE (keep scoreboard last result); otherwise PAID etc just inactive
      const newStatus: FreeStatus = row.free_status === "FREE" ? "PREVIOUSLY_FREE" : (row.free_status as FreeStatus);
      await db
        .prepare("UPDATE models SET active=0, free_status=?, last_seen=? WHERE id=?")
        .bind(newStatus, nowIso, row.id)
        .run();
    }
  }
}

export async function insertBenchmarkRun(db: D1Database, modelId: number, r: BenchmarkResult): Promise<number> {
  const ins = await db
    .prepare(
      `INSERT INTO benchmark_runs (model_id, benchmark_type, started_at, first_token_at, completed_at, input_tokens, output_tokens, ttft_ms, generation_ms, tps, status, error_type, http_status, provider, model, token_estimation_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

export function parseRange(range: string): { hours: number; sinceIso: string } | null {
  const map: Record<string, number> = { "1h": 1, "24h": 24, "3d": 72, "7d": 168 };
  const h = map[range];
  if (!h) return null;
  const since = new Date(Date.now() - h * 3600 * 1000).toISOString();
  return { hours: h, sinceIso: since };
}

export async function getModels(db: D1Database, opts: { provider?: string; freeOnly?: boolean; includeInactive?: boolean } = {}) {
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

export async function computeHourlyAggregates(db: D1Database, forHourStart: string) {
  // forHourStart is truncated to hour "YYYY-MM-DDTHH:00:00.000Z"
  const hourStart = forHourStart;
  const hourEnd = new Date(new Date(hourStart).getTime() + 3600 * 1000).toISOString();
  // get per-model per-benchmark groups
  const rows = await db
    .prepare(
      `SELECT model_id, benchmark_type,
        GROUP_CONCAT(tps) as tpss,
        GROUP_CONCAT(ttft_ms) as ttfts,
        COUNT(*) as cnt,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END) as fails
     FROM benchmark_runs
     WHERE started_at >= ? AND started_at < ?
     GROUP BY model_id, benchmark_type`,
    )
    .bind(hourStart, hourEnd)
    .all<{ model_id: number; benchmark_type: BenchmarkType; tpss: string; ttfts: string; cnt: number; success: number; fails: number }>();

  for (const r of rows.results ?? []) {
    const tpss = (r.tpss ?? "").split(",").map(Number).filter((n) => !isNaN(n) && n > 0);
    const ttfts = (r.ttfts ?? "").split(",").map(Number).filter((n) => !isNaN(n) && n > 0);
    const avg_tps = tpss.length ? tpss.reduce((a, b) => a + b, 0) / tpss.length : null;
    const median_tps = percentile(tpss, 50);
    const p90_tps = percentile(tpss, 90);
    const p95_tps = percentile(tpss, 95);
    const avg_ttft = ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null;
    const median_ttft = percentile(ttfts, 50);
    const p90_ttft = percentile(ttfts, 90);
    const p95_ttft = percentile(ttfts, 95);
    const success_rate = r.cnt ? r.success / r.cnt : 0;
    const uptime = r.cnt ? r.success / r.cnt : 0;
    await db
      .prepare(
        `INSERT OR REPLACE INTO hourly_model_stats (model_id, hour_start, benchmark_type, avg_tps, median_tps, p90_tps, p95_tps, avg_ttft, median_ttft, p90_ttft, p95_ttft, success_rate, error_rate, uptime, request_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        success_rate,
        1 - success_rate,
        uptime,
        r.cnt,
      )
      .run();
  }
}

function percentile(vals: number[], p: number): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, Math.min(idx, s.length - 1))] ?? null;
}

export async function cleanupRetention(db: D1Database, rawDays = 7, hourlyDays = 30) {
  const rawCut = new Date(Date.now() - rawDays * 86400 * 1000).toISOString();
  const hourlyCut = new Date(Date.now() - hourlyDays * 86400 * 1000).toISOString();
  await db.prepare("DELETE FROM benchmark_runs WHERE started_at < ?").bind(rawCut).run();
  await db.prepare("DELETE FROM hourly_model_stats WHERE hour_start < ?").bind(hourlyCut).run();
  // incidents indefinite, but we prune ended ones older than 90d if wanted (keep indefinite per spec)
}
