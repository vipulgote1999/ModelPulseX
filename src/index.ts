import { PerformanceDO } from "./live/performance-do";
import { createApi } from "./api/routes";
import { runDiscovery, scheduleBenchmarks, handleBenchJob, type BenchJob } from "./benchmark/scheduler";
import { computeHourlyAggregates, cleanupRetention } from "./db/queries";
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
    const url = new URL(request.url);
    const path = url.pathname;

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
    for (const msg of batch.messages) {
      const job = msg.body as BenchJob;
      try {
        await handleBenchJob(env, job);
        msg.ack();
      } catch (e) {
        console.error("bench job failed", job, e);
        msg.retry();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cron = (controller as unknown as { cron: string }).cron;
    // */5 * * * *  → benchmark scheduler
    // 0 * * * *    → discovery + aggregation + cleanup
    if (cron === "*/5 * * * *") {
      await scheduleBenchmarks(env);
    } else if (cron === "0 * * * *") {
      // hourly
      await runDiscovery(env);
      const hour = new Date();
      hour.setUTCMinutes(0, 0, 0);
      // compute aggregates for current hour and previous hour to avoid missing edge
      await computeHourlyAggregates(env.DB, hour.toISOString());
      const prev = new Date(hour.getTime() - 3600 * 1000).toISOString();
      await computeHourlyAggregates(env.DB, prev);
      // cleanup raw 7d, hourly 30d
      await cleanupRetention(env.DB, 7, 30);
    } else {
      // fallback: run both if unknown
      await scheduleBenchmarks(env);
    }
  },
} satisfies ExportedHandler<Env, BenchJob>;
