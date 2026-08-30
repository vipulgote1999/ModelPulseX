import { Hono } from "hono";
import type { Env } from "../types";
import { getSchedulerHealth, getLastBenchmarkAt } from "../db/health";

export function healthRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/health", async (c) => {
    const base = { ok: true, time: new Date().toISOString(), version: "0.1.0" };
    // Freshness probe for external uptime monitors: /api/health?freshness=<minutes>
    // returns 503 when the newest measurement is older than N minutes (default 15).
    // Lets UptimeRobot/BetterStack catch a stalled pipeline that plain 200s would hide.
    const freshnessParam = c.req.query("freshness");
    if (freshnessParam === undefined) return c.json(base);
    const minutes = Math.max(1, Number(freshnessParam) || 15);
    const [lastBench, sched] = await Promise.all([
      getLastBenchmarkAt(env.DB),
      getSchedulerHealth(env.DB),
    ]);
    const ageMinutes = lastBench
      ? Math.round((Date.now() - new Date(lastBench).getTime()) / 60000)
      : null;
    const fresh = ageMinutes != null && ageMinutes <= minutes;
    return c.json(
      {
        ...base,
        ok: fresh,
        fresh,
        freshness_threshold_minutes: minutes,
        last_benchmark: lastBench,
        age_minutes: ageMinutes,
        scheduler: sched,
      },
      fresh ? 200 : 503,
    );
  });
  return r;
}
