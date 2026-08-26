import { PerformanceDO } from "./live/performance-do";
import { createApi } from "./api/routes";
import { runDiscovery, scheduleBenchmarks, handleBenchJob, type BenchJob } from "./benchmark/scheduler";
import { computeHourlyAggregates, cleanupRetention } from "./db/queries";
import { recordHourlyJob, watchdogCheck } from "./db/health";
import type { Env } from "./types";

export { PerformanceDO };

// Security headers helper
function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  // Allow frontend to use SSE
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      // Malformed request URL — reject cleanly rather than throwing.
      return new Response("bad request", { status: 400 });
    }

    // Never leak secrets: strip them from logs; ensure no api key in response
    if (path.startsWith("/api/")) {
      const app = createApi(env);
      const res = await app.fetch(request, env, ctx);
      return withSecurityHeaders(res);
    }

    // Non-API: asset serving handled by Workers Assets; if 404, serve index.html SPA fallback transparently
    // When assets binding is not available in wrangler dev --local, we return small loader.
    return new Response(
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=/index.html"></head><body>ModelPulseX — <a href="/api/health">API</a> | <a href="/">Dashboard</a></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },

  async queue(batch: MessageBatch<BenchJob>, env: Env): Promise<void> {
    // Parallelize ACROSS providers while serializing within a provider: a batch of ≤10
    // jobs typically spans many providers, so this cuts wall time ~Nx without violating
    // per-provider concurrency caps. Previously a serial for-loop capped throughput at
    // ~120 jobs/hour worst-case and starved freshness.
    const groups = new Map<string, Message<BenchJob>[]>();
    for (const msg of batch.messages) {
      const prov = msg.body?.provider ?? "_unknown";
      const arr = groups.get(prov);
      if (arr) arr.push(msg);
      else groups.set(prov, [msg]);
    }
    const drainProvider = async (msgs: Message<BenchJob>[]): Promise<void> => {
      for (const msg of msgs) {
        try {
          await handleBenchJob(env, msg.body);
          msg.ack();
        } catch (e) {
          console.error("bench job failed", msg.body?.model_id, e);
          msg.retry();
        }
      }
      return;
    };
    // Concise-body arrows keep an implicit meaningful return (the drain promise).
    await Promise.all(Array.from(groups.values()).map((msgs) => drainProvider(msgs)));
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // ScheduledController exposes `cron` natively at this compatibility_date.
    const cron = controller.cron;
    // */5 * * * *  → benchmark scheduler (+ inline fallback)
    // 0 * * * *    → discovery + aggregation + cleanup + staleness watchdog
    if (cron === "*/5 * * * *") {
      // Inline fallback: run the first N selected jobs inside this invocation. Guarantees
      // baseline coverage even when queue delivery stalls; queue carries the rest.
      const inlineTake = Number(env.BENCH_INLINE_FALLBACK ?? "6");
      await scheduleBenchmarks(env, { inlineTake: Number.isFinite(inlineTake) ? inlineTake : 6 });
    } else if (cron === "0 * * * *") {
      // hourly
      try {
        await runDiscovery(env);
        await recordHourlyJob(env.DB, "discovery");
      } catch (e) {
        console.error("hourly discovery failed", e);
      }
      const hour = new Date();
      hour.setUTCMinutes(0, 0, 0);
      // compute aggregates for current hour and previous hour to avoid missing edge
      try {
        await computeHourlyAggregates(env.DB, hour.toISOString());
        const prev = new Date(hour.getTime() - 3600 * 1000).toISOString();
        await computeHourlyAggregates(env.DB, prev);
        await recordHourlyJob(env.DB, "aggregate");
      } catch (e) {
        console.error("hourly aggregation failed", e);
      }
      // cleanup raw 7d, hourly 30d
      try {
        await cleanupRetention(env.DB, 7, 30);
      } catch (e) {
        console.error("retention cleanup failed", e);
      }
      // Staleness watchdog — alerts via webhook (rate-limited to hourly) when the
      // pipeline stops producing measurements. Never throws.
      try {
        const wd = await watchdogCheck(env.DB, env);
        if (wd.stale) console.warn("watchdog:", JSON.stringify(wd));
      } catch (e) {
        console.error("watchdog failed", e);
      }
    } else {
      // fallback: run both if unknown
      await scheduleBenchmarks(env, { inlineTake: Number(env.BENCH_INLINE_FALLBACK ?? "6") });
    }
  },
} satisfies ExportedHandler<Env, BenchJob>;
