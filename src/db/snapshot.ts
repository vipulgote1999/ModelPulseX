import type { Env } from "../types";
import { freeHardFilterWhere } from "../providers/registry";
import { percentile, parseConcatNumbers, MIN_SAMPLES } from "../utils/metrics";

export const SNAPSHOT_BENCHMARKS = [
  "all",
  "short",
  "medium",
  "coding",
] as const;

export interface SnapshotMeta {
  id: number;
  provider_model_id: string;
  display_name: string;
  free_status: string;
  active: number;
  provider: string;
}

export interface SnapshotRaw {
  model_id: number;
  benchmark_type: string;
  cnt_1h: number | null;
  g_tps_1h: string | null;
  g_ttft_1h: string | null;
  cnt_24h: number | null;
  g_tps_24h: string | null;
  g_ttft_24h: string | null;
  cnt7: number | null;
  g_tps_7d: string | null;
  g_ttft_7d: string | null;
  g_itl_7d: string | null;
  ok_7d: number | null;
  tot_7d: number | null;
}

export interface SnapshotSpark {
  model_id: number;
  benchmark_type: string;
  hour_start: string;
  v: number | null;
}

export interface SnapshotRow {
  benchmark: string;
  model_id: number;
  display_name: string;
  provider: string;
  provider_model_id: string;
  free_status: string;
  active: number;
  tps_1h: number | null;
  tps_24h: number | null;
  tps_7d: number | null;
  ttft_1h: number | null;
  ttft_24h: number | null;
  ttft_7d: number | null;
  itl_7d: number | null;
  uptime_7d: number | null;
  error_rate_7d: number | null;
  sparkline: string;
  sample_count_24h: number;
  request_count_7d: number;
}

function medianOf(gc: string | null): number | null {
  if (!gc) return null;
  return percentile(parseConcatNumbers(gc), 50);
}

function gatedRaw(
  gc: string | null,
  cnt: number | null,
  min: number,
): number | null {
  if ((cnt ?? 0) >= min) return medianOf(gc);
  return null;
}

/** Pure shaping: raw GROUP_CONCAT rows + hourly spark points → snapshot rows.
 *  Unit-tested; mirrors the live leaderboard's medians + min-sample gates, but
 *  derives everything from the raw 7d window (exact medians) instead of
 *  averaging hourly medians. Methodology documents the snapshot path. */
export function buildSnapshotRows(input: {
  models: SnapshotMeta[];
  raw: SnapshotRaw[];
  spark: SnapshotSpark[];
  nowIso: string;
}): SnapshotRow[] {
  const { models, raw, spark, nowIso } = input;
  const byModelBench = new Map<string, SnapshotRaw[]>();
  for (const r of raw) {
    const k = `${r.model_id}\n${r.benchmark_type}`;
    const arr = byModelBench.get(k) ?? [];
    arr.push(r);
    byModelBench.set(k, arr);
  }
  const sparkByModelBench = new Map<
    string,
    Array<{ t: string; v: number | null }>
  >();
  for (const s of spark) {
    const k = `${s.model_id}\n${s.benchmark_type}`;
    const arr = sparkByModelBench.get(k) ?? [];
    arr.push({ t: s.hour_start, v: s.v });
    sparkByModelBench.set(k, arr);
  }

  const mergedRaw = (
    modelId: number,
    bench: string,
  ): {
    cnt_1h: number;
    g_tps_1h: string | null;
    g_ttft_1h: string | null;
    cnt_24h: number;
    g_tps_24h: string | null;
    g_ttft_24h: string | null;
    cnt7: number;
    g_tps_7d: string | null;
    g_ttft_7d: string | null;
    g_itl_7d: string | null;
    ok_7d: number;
    tot_7d: number;
  } => {
    const lists =
      bench === "all"
        ? SNAPSHOT_BENCHMARKS.filter((b) => b !== "all").flatMap(
            (b) => byModelBench.get(`${modelId}\n${b}`) ?? [],
          )
        : (byModelBench.get(`${modelId}\n${bench}`) ?? []);
    const cat = (pick: (r: SnapshotRaw) => string | null): string | null => {
      const parts = lists
        .map(pick)
        .filter((s): s is string => s != null && s !== "");
      return parts.length ? parts.join(",") : null;
    };
    const sum = (pick: (r: SnapshotRaw) => number | null): number =>
      lists.reduce((s, r) => s + (pick(r) ?? 0), 0);
    return {
      cnt_1h: sum((r) => r.cnt_1h),
      g_tps_1h: cat((r) => r.g_tps_1h),
      g_ttft_1h: cat((r) => r.g_ttft_1h),
      cnt_24h: sum((r) => r.cnt_24h),
      g_tps_24h: cat((r) => r.g_tps_24h),
      g_ttft_24h: cat((r) => r.g_ttft_24h),
      cnt7: sum((r) => r.cnt7),
      g_tps_7d: cat((r) => r.g_tps_7d),
      g_ttft_7d: cat((r) => r.g_ttft_7d),
      g_itl_7d: cat((r) => r.g_itl_7d),
      ok_7d: sum((r) => r.ok_7d),
      tot_7d: sum((r) => r.tot_7d),
    };
  };

  const sparklineFor = (modelId: number, bench: string): string => {
    if (bench === "all") {
      // Average across benchmark types per hour (same multiset average the
      // live path computes with AVG over unfiltered rows).
      const perHour = new Map<string, { sum: number; n: number }>();
      for (const b of SNAPSHOT_BENCHMARKS) {
        if (b === "all") continue;
        for (const p of sparkByModelBench.get(`${modelId}\n${b}`) ?? []) {
          if (p.v == null) continue;
          const e = perHour.get(p.t) ?? { sum: 0, n: 0 };
          e.sum += p.v;
          e.n += 1;
          perHour.set(p.t, e);
        }
      }
      const pts = [...perHour.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, e]) => e.sum / e.n);
      return JSON.stringify(pts.slice(-24));
    }
    const pts = (sparkByModelBench.get(`${modelId}\n${bench}`) ?? [])
      .map((p) => p.v)
      .slice(-24);
    return JSON.stringify(pts);
  };

  const out: SnapshotRow[] = [];
  for (const m of models) {
    for (const bench of SNAPSHOT_BENCHMARKS) {
      const g = mergedRaw(m.id, bench);
      const uptime_7d =
        g.cnt7 >= MIN_SAMPLES.w7d && g.tot_7d > 0 ? g.ok_7d / g.tot_7d : null;
      out.push({
        benchmark: bench,
        model_id: m.id,
        display_name: m.display_name,
        provider: m.provider,
        provider_model_id: m.provider_model_id,
        free_status: m.free_status,
        active: m.active,
        tps_1h: gatedRaw(g.g_tps_1h, g.cnt_1h, MIN_SAMPLES.w1h),
        tps_24h: gatedRaw(g.g_tps_24h, g.cnt_24h, MIN_SAMPLES.w24h),
        tps_7d: gatedRaw(g.g_tps_7d, g.cnt7, MIN_SAMPLES.w7d),
        ttft_1h: gatedRaw(g.g_ttft_1h, g.cnt_1h, MIN_SAMPLES.w1h),
        ttft_24h: gatedRaw(g.g_ttft_24h, g.cnt_24h, MIN_SAMPLES.w24h),
        ttft_7d: gatedRaw(g.g_ttft_7d, g.cnt7, MIN_SAMPLES.w7d),
        itl_7d: gatedRaw(g.g_itl_7d, g.cnt7, MIN_SAMPLES.w7d),
        uptime_7d,
        error_rate_7d: uptime_7d != null ? 1 - uptime_7d : null,
        sparkline: sparklineFor(m.id, bench),
        sample_count_24h: g.cnt_24h,
        request_count_7d: g.cnt7,
      });
    }
  }
  void nowIso;
  return out;
}

/** Hourly writer: one raw GROUP_CONCAT pass + hourly spark read, shaped in JS,
 *  batch-upserted. Fixed cost per tick (~20k rows); never throws (must not
 *  break the hourly cron). Missing table pre-migration → warn + skip. */
export async function refreshLeaderboardSnapshot(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<{ models: number; rows: number }> {
  const since7d = new Date(nowMs - 7 * 86400 * 1000).toISOString();
  const since24h = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  try {
    const hardFilter = freeHardFilterWhere("p", "m");
    const [modelsRes, rawRes, sparkRes] = await db.batch([
      db.prepare(
        `SELECT m.id, m.provider_model_id, m.display_name, m.free_status, m.active, p.name as provider
           FROM models m JOIN providers p ON p.id=m.provider_id
           WHERE (m.free_status='FREE' OR m.free_status='PREVIOUSLY_FREE') AND COALESCE(m.benchmark_enabled,1)=1${hardFilter}
           ORDER BY m.display_name`,
      ),
      db
        .prepare(
          `SELECT model_id, benchmark_type,
           SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) as cnt_1h,
           GROUP_CONCAT(CASE WHEN started_at >= ? THEN tps END) as g_tps_1h,
           GROUP_CONCAT(CASE WHEN started_at >= ? THEN ttft_ms END) as g_ttft_1h,
           SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) as cnt_24h,
           GROUP_CONCAT(CASE WHEN started_at >= ? THEN tps END) as g_tps_24h,
           GROUP_CONCAT(CASE WHEN started_at >= ? THEN ttft_ms END) as g_ttft_24h,
           COUNT(*) as cnt7,
           GROUP_CONCAT(tps) as g_tps_7d,
           GROUP_CONCAT(ttft_ms) as g_ttft_7d,
           GROUP_CONCAT(itl_ms) as g_itl_7d,
           SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok_7d,
           COUNT(*) as tot_7d
         FROM benchmark_runs WHERE started_at >= ?
         GROUP BY model_id, benchmark_type`,
        )
        .bind(
          new Date(nowMs - 1 * 3600 * 1000).toISOString(),
          new Date(nowMs - 1 * 3600 * 1000).toISOString(),
          new Date(nowMs - 1 * 3600 * 1000).toISOString(),
          new Date(nowMs - 24 * 3600 * 1000).toISOString(),
          new Date(nowMs - 24 * 3600 * 1000).toISOString(),
          new Date(nowMs - 24 * 3600 * 1000).toISOString(),
          since7d,
        ),
      db
        .prepare(
          `SELECT model_id, benchmark_type, hour_start, AVG(median_tps) as v
         FROM hourly_model_stats WHERE hour_start >= ?
         GROUP BY model_id, benchmark_type, hour_start ORDER BY hour_start ASC`,
        )
        .bind(since24h),
    ]);
    const models = (modelsRes?.results ?? []) as SnapshotMeta[];
    const raw = (rawRes?.results ?? []) as SnapshotRaw[];
    const spark = (sparkRes?.results ?? []) as SnapshotSpark[];
    const rows = buildSnapshotRows({ models, raw, spark, nowIso });
    // Sweep rows for models no longer servable (deactivated/paid) or stale
    // benchmark sets: anything not refreshed by this tick is deleted by its
    // snapshot_at instead of tracking churn explicitly.
    // Upsert in chunks (stay under D1 batch variable limits).
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await db.batch(
        chunk.map((r) =>
          db
            .prepare(
              `INSERT INTO leaderboard_snapshot
               (benchmark, model_id, display_name, provider, provider_model_id, free_status, active,
                tps_1h, tps_24h, tps_7d, ttft_1h, ttft_24h, ttft_7d, itl_7d,
                uptime_7d, error_rate_7d, sparkline, sample_count_24h, request_count_7d, snapshot_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(benchmark, model_id) DO UPDATE SET
                 display_name=excluded.display_name, provider=excluded.provider,
                 provider_model_id=excluded.provider_model_id, free_status=excluded.free_status,
                 active=excluded.active, tps_1h=excluded.tps_1h, tps_24h=excluded.tps_24h,
                 tps_7d=excluded.tps_7d, ttft_1h=excluded.ttft_1h, ttft_24h=excluded.ttft_24h,
                 ttft_7d=excluded.ttft_7d, itl_7d=excluded.itl_7d, uptime_7d=excluded.uptime_7d,
                 error_rate_7d=excluded.error_rate_7d, sparkline=excluded.sparkline,
                 sample_count_24h=excluded.sample_count_24h, request_count_7d=excluded.request_count_7d,
                 snapshot_at=excluded.snapshot_at`,
            )
            .bind(
              r.benchmark,
              r.model_id,
              r.display_name,
              r.provider,
              r.provider_model_id,
              r.free_status,
              r.active,
              r.tps_1h,
              r.tps_24h,
              r.tps_7d,
              r.ttft_1h,
              r.ttft_24h,
              r.ttft_7d,
              r.itl_7d,
              r.uptime_7d,
              r.error_rate_7d,
              r.sparkline,
              r.sample_count_24h,
              r.request_count_7d,
              nowIso,
            ),
        ),
      );
    }
    return { models: models.length, rows: rows.length };
  } catch (e) {
    console.warn("snapshot refresh", e);
    return { models: 0, rows: 0 };
  }
}

export interface NowEntry {
  tps: number | null;
  ttft: number | null;
  itl: number | null;
  status: string;
  at: string;
}

/** Latest-run overlay: pick the per-benchmark entry, or the newest across
 *  types for the 'all' view. Pure + unit-tested. */
export function nowFor(json: string | null, bench: string): NowEntry | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, NowEntry>;
    if (bench !== "all") return o[bench] ?? null;
    let best: NowEntry | null = null;
    for (const v of Object.values(o)) {
      if (v && (!best || (v.at ?? "") > (best.at ?? ""))) best = v;
    }
    return best;
  } catch {
    return null;
  }
}

export function snapshotRoutesEnv(_env: Env): void {
  void _env;
}
