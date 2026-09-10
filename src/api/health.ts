import { Hono } from "hono";
import type { Env } from "../types";
import {
  getSchedulerHealth,
  getLastBenchmarkAt,
  alertChannelState,
} from "../db/health";
import { getRowsReadToday, rowsCap, utcDay } from "../db/query-cost";

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
    const [lastBench, sched, rowsToday] = await Promise.all([
      getLastBenchmarkAt(env.DB),
      getSchedulerHealth(env.DB),
      getRowsReadToday(env.DB),
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
        // Watchdog configuration is part of health: `log-only` means a stall
        // would only reach Workers Logs, not an operator (issue #22).
        scheduler: { ...sched, alert_channel: alertChannelState(env) },
        // D1 budget visibility without the Cloudflare dashboard (issue #12).
        // `lower_bound: true` because only instrumented query shapes are counted.
        d1_budget: {
          day: rowsToday?.day ?? utcDay(),
          rows_read_measured_today: rowsToday?.rows_read ?? null,
          top_shape: rowsToday?.top_shape ?? null,
          top_rows: rowsToday?.top_rows ?? null,
          cap: rowsCap(env),
          lower_bound: true,
        },
      },
      fresh ? 200 : 503,
    );
  });
  return r;
}
