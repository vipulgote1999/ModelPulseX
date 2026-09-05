import { Hono } from "hono";
import type { Env } from "../types";
import { parseRange } from "../db/queries";

export function timeoutsRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  // Timeout / rate-limit history — who says no, when, how often.
  // Reads raw benchmark_runs (7–14d TTL), so the window is bounded by retention.
  // No migration: pure aggregation over existing columns.
  // Single db.batch round-trip (3 independent aggregations, no data deps).
  r.get("/timeouts", async (c) => {
    const range = c.req.query("range") ?? "7d";
    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const { sinceIso, hours } = parsed;
    // Hourly buckets for short ranges, daily otherwise
    const bucketLen = hours <= 24 ? 13 : 10;
    // Edge-cache 60s shared across visitors (matches browser TTL below): full
    // 7d raw scan + GROUP BY per hit is the most expensive dashboard query.
    // SAFETY: Workers runtime exposes caches.default at runtime; DOM lib types omit it.
    const cache: Cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(c.req.url, { method: "GET" });
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      // Cache API unavailable (local dev) — fall through to D1
    }
    const [failedRes, providersRes, topModelsRes] = await env.DB.batch([
      env.DB.prepare(
        `SELECT substr(started_at,1,${bucketLen}) AS bucket, provider, status, COUNT(*) AS n
         FROM benchmark_runs WHERE started_at >= ? AND status != 'SUCCESS'
         GROUP BY bucket, provider, status ORDER BY bucket ASC`,
      ).bind(sinceIso),
      env.DB.prepare(
        `SELECT provider,
          SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) AS ok,
          SUM(CASE WHEN status='RATE_LIMITED' THEN 1 ELSE 0 END) AS rate_limited,
          SUM(CASE WHEN status='TIMEOUT' THEN 1 ELSE 0 END) AS timeouts,
          SUM(CASE WHEN status NOT IN ('SUCCESS','RATE_LIMITED','TIMEOUT') THEN 1 ELSE 0 END) AS other_errors,
          COUNT(*) AS total
         FROM benchmark_runs WHERE started_at >= ? GROUP BY provider ORDER BY total DESC`,
      ).bind(sinceIso),
      env.DB.prepare(
        `SELECT provider, model, COUNT(*) AS n FROM benchmark_runs
         WHERE started_at >= ? AND status != 'SUCCESS'
         GROUP BY provider, model ORDER BY n DESC LIMIT 10`,
      ).bind(sinceIso),
    ]);
    // SAFETY: D1 batch returns untyped rows; SELECT aliases match the shapes below
    const rows = (failedRes?.results ?? []) as Array<{
      bucket: string;
      provider: string;
      status: string;
      n: number;
    }>;
    const provs = (providersRes?.results ?? []) as Array<{
      provider: string;
      ok: number;
      rate_limited: number;
      timeouts: number;
      other_errors: number;
      total: number;
    }>;
    const topModels = (topModelsRes?.results ?? []) as Array<{
      provider: string;
      model: string;
      n: number;
    }>;
    const totalRuns = provs.reduce((s, p) => s + p.total, 0);
    const resp = c.json({
      range,
      granularity: hours <= 24 ? "hourly" : "daily",
      failures: rows,
      providers: provs,
      topModels,
      meta: {
        observed_window: sinceIso,
        total_runs: totalRuns,
        total_failures: rows.reduce((s, x) => s + x.n, 0),
        retention_note:
          "raw benchmark_runs retained 7–14d; older timeouts age out",
      },
    });
    resp.headers.set(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=120",
    );
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    } catch {
      // cache put best-effort
    }
    return resp;
  });
  return r;
}
