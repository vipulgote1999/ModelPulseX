import { Hono } from "hono";
import type { Env } from "../types";
import { parseRange } from "../db/queries";

export function historyRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  // Batch history for charts — single request instead of N fetches
  // Supports granularity=10m for 5–10m live lines (tenmin_model_stats). Default hourly.
  r.get("/history", async (c) => {
    const idsParam = c.req.query("ids") ?? c.req.query("models") ?? "";
    const range = c.req.query("range") ?? "7d";
    const benchmark = c.req.query("benchmark") ?? "all";
    const granularity = c.req.query("granularity") ?? (range === "1h" ? "10m" : "hourly");
    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;
    const ids = idsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 12);
    if (ids.length === 0)
      return c.json({ error: "ids required, e.g. ?ids=1,2,3" }, 400);
    const placeholders = ids.map(() => "?").join(",");
    const useTenmin = granularity === "10m";
    let sql: string;
    let binds: unknown[];
    if (useTenmin) {
      if (benchmark === "all") {
        sql = `SELECT model_id, bucket_start as hour_start, AVG(avg_tps) as avg_tps, AVG(median_tps) as median_tps, AVG(p90_tps) as p90_tps, AVG(avg_ttft) as avg_ttft, AVG(median_ttft) as median_ttft, AVG(p90_ttft) as p90_ttft, AVG(success_rate) as success_rate, AVG(uptime) as uptime, SUM(request_count) as request_count FROM tenmin_model_stats WHERE model_id IN (${placeholders}) AND bucket_start >= ? GROUP BY model_id, bucket_start ORDER BY model_id, bucket_start ASC`;
        binds = [...ids, since];
      } else {
        sql = `SELECT model_id, bucket_start as hour_start, benchmark_type, avg_tps, median_tps, p90_tps, avg_ttft, median_ttft, p90_ttft, success_rate, uptime, request_count FROM tenmin_model_stats WHERE model_id IN (${placeholders}) AND bucket_start >= ? AND benchmark_type=? ORDER BY model_id, bucket_start ASC`;
        binds = [...ids, since, benchmark];
      }
    } else if (benchmark === "all") {
      // Average across benchmark_types per hour for correctness when benchmark=all
      sql = `SELECT model_id, hour_start, AVG(avg_tps) as avg_tps, AVG(median_tps) as median_tps, AVG(p90_tps) as p90_tps, AVG(avg_ttft) as avg_ttft, AVG(median_ttft) as median_ttft, AVG(p90_ttft) as p90_ttft, AVG(success_rate) as success_rate, AVG(uptime) as uptime, SUM(request_count) as request_count FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? GROUP BY model_id, hour_start ORDER BY model_id, hour_start ASC`;
      binds = [...ids, since];
    } else {
      sql = `SELECT model_id, hour_start, benchmark_type, avg_tps, median_tps, p90_tps, avg_ttft, median_ttft, p90_ttft, success_rate, uptime, request_count FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? AND benchmark_type=? ORDER BY model_id, hour_start ASC`;
      binds = [...ids, since, benchmark];
    }
    let rows: { results?: unknown[] } | undefined;
    try {
      rows = await env.DB.prepare(sql).bind(...binds).all();
    } catch (e) {
      const msg = String(e);
      if (useTenmin && (msg.includes("tenmin_model_stats") || msg.includes("no such table"))) {
        // tenmin table not yet migrated — fall back to hourly inline
        const fallbackSql = benchmark === "all"
          ? `SELECT model_id, hour_start, AVG(avg_tps) as avg_tps, AVG(median_tps) as median_tps, AVG(p90_tps) as p90_tps, AVG(avg_ttft) as avg_ttft, AVG(median_ttft) as median_ttft, AVG(p90_ttft) as p90_ttft, AVG(success_rate) as success_rate, AVG(uptime) as uptime, SUM(request_count) as request_count FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? GROUP BY model_id, hour_start ORDER BY model_id, hour_start ASC`
          : `SELECT model_id, hour_start, benchmark_type, avg_tps, median_tps, p90_tps, avg_ttft, median_ttft, p90_ttft, success_rate, uptime, request_count FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? AND benchmark_type=? ORDER BY model_id, hour_start ASC`;
        const fbBinds = benchmark === "all" ? [...ids, since] : [...ids, since, benchmark];
        rows = await env.DB.prepare(fallbackSql).bind(...fbBinds).all();
      } else throw e;
    }
    const byModel: Record<number, unknown[]> = {};
    for (const id of ids) byModel[id] = [];
    for (const r of (rows?.results ?? []) as Array<{ model_id: number } & Record<string, unknown>>) {
      (byModel[r.model_id] ??= []).push(r);
    }
    const emptyIds = ids.filter((id) => (byModel[id] ?? []).length === 0);
    if (emptyIds.length > 0) {
      const ph2 = emptyIds.map(() => "?").join(",");
      let rawSql = `SELECT model_id, started_at as hour_start, benchmark_type, tps as avg_tps, tps as median_tps, ttft_ms as avg_ttft, ttft_ms as median_ttft, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as uptime, 1 as request_count, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as success_rate FROM benchmark_runs WHERE model_id IN (${ph2}) AND started_at >= ?`;
      const rawBinds: unknown[] = [...emptyIds, since];
      if (benchmark !== "all") {
        rawSql += " AND benchmark_type=?";
        rawBinds.push(benchmark);
      }
      rawSql += " ORDER BY model_id, started_at ASC LIMIT 200";
      const raw = await env.DB.prepare(rawSql).bind(...rawBinds).all();
      for (const r of (raw.results ?? []) as Array<{ model_id: number } & Record<string, unknown>>) {
        (byModel[r.model_id] ??= []).push(r);
      }
    }
    return c.json({
      history: byModel,
      range,
      benchmark,
      granularity: useTenmin ? "10m" : "hourly",
      meta: { observed_window: since },
    });
  });
  return r;
}
