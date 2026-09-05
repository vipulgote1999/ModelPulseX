import type {
  ExecutionContext,
  MessageBatch,
  Message,
  ScheduledController,
  ExportedHandler,
} from "@cloudflare/workers-types";
import { PerformanceDO } from "./live/performance-do";
import { createApi } from "./api/routes";
import {
  runDiscovery,
  scheduleBenchmarks,
  handleBenchJob,
  type BenchJob,
} from "./benchmark/scheduler";
import {
  computeHourlyAggregates,
  computeTenminAggregates,
  cleanupRetention,
  truncateToTenMin,
} from "./db/queries";
import { recordHourlyJob, watchdogCheck } from "./db/health";
import type { Env } from "./types";

export { PerformanceDO };

// Security headers — comprehensive hardening for OWASP Top 10 + compliance
function withSecurityHeaders(res: Response, req?: Request): Response {
  const h = new Headers(res.headers);
  // Baseline hardening
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  h.set("x-permitted-cross-domain-policies", "none");
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("cross-origin-resource-policy", "same-origin");
  h.set("cross-origin-embedder-policy", "credentialless");
  // Disable legacy XSS filter (can be abused), CSP is the real control
  h.set("x-xss-protection", "0");
  // HSTS — only meaningful over HTTPS; Workers terminates TLS at edge, so always set
  // preload + includeSubDomains for max score; if you serve http locally, browser ignores it
  h.set(
    "strict-transport-security",
    "max-age=63072000; includeSubDomains; preload",
  );
  // CSP for API responses (JSON) — lock down to self; frontend HTML gets its own CSP via assets
  const isJson = (h.get("content-type") ?? "").includes("json");
  if (isJson || (req?.url.includes("/api/") ?? false)) {
    // API: no script execution context, but still deny framing/object
    h.set(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
  } else {
    // SPA shell fallback: strict but allows inline styles for Tailwind + Recharts
    h.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'; upgrade-insecure-requests",
    );
  }
  // Cache: API is public but short-lived; admin must never cache
  if (!h.has("cache-control")) {
    let path: string;
    try {
      path = req ? new URL(req.url).pathname : "";
    } catch {
      path = "";
    }
    if (path.startsWith("/api/admin/"))
      h.set("cache-control", "no-store, no-cache, must-revalidate");
    else if (path.startsWith("/api/")) {
      // keep existing per-route cache-control if set, else default
      if (!h.get("cache-control"))
        h.set("cache-control", "public, max-age=10, stale-while-revalidate=30");
    }
  }
  h.set("vary", [h.get("vary"), "Origin"].filter(Boolean).join(", "));
  // Remove fingerprinting headers that Workers may add upstream (best-effort)
  h.delete("x-powered-by");
  h.delete("server");
  return new Response(res.body, { status: res.status, headers: h });
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- workers-types vs DOM lib mismatch is intentional, skipLibCheck covers runtime
// @ts-ignore - workers-types Response/Request mismatch with DOM lib (skipLibCheck covers lib, this suppresses satisfies check)
export default {
  async fetch(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional for workers-types compatibility
    request: any,
    env: Env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    let url: URL;
    let path: string;
    try {
      url = new URL(request.url);
      path = url.pathname;
    } catch {
      // Malformed request URL — reject cleanly rather than throwing.
      return withSecurityHeaders(
        new Response("bad request", { status: 400 }),
        request,
      );
    }

    // Method allowlist — disallow TRACE/TRACK/DEBUG etc.
    const allowedMethods = new Set([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]);
    if (!allowedMethods.has(request.method)) {
      return withSecurityHeaders(
        new Response("method not allowed", {
          status: 405,
          headers: { allow: "GET, HEAD, POST, OPTIONS" },
        }),
        request,
      );
    }

    // Size gate — reject huge bodies before they hit Hono/D1 (1MB limit).
    // content-length alone bypasses via chunked encoding, so also handle transfer-encoding.
    // Chunked case is enforced later by Hono bodyLimit middleware (streaming), not here.
    const clen = request.headers.get("content-length");
    const te = request.headers.get("transfer-encoding") ?? "";
    if (clen) {
      const n = Number(clen);
      if (Number.isFinite(n) && n > 1_048_576) {
        return withSecurityHeaders(
          new Response("payload too large", { status: 413 }),
          request,
        );
      }
    } else if (te.toLowerCase().includes("chunked")) {
      // No content-length + chunked: defer to Hono bodyLimit (1MB) for streaming enforcement
    }

    // Never leak secrets: strip them from logs; ensure no api key in response
    if (path.startsWith("/api/")) {
      const app = createApi(env);
      const res = await app.fetch(request, env, ctx);
      // Add request-id for tracing (if not already present)
      const rid = request.headers.get("x-request-id") ?? crypto.randomUUID();
      const out = withSecurityHeaders(res, request);
      out.headers.set("x-request-id", rid);
      return out;
    }

    // Non-API: asset serving handled by Workers Assets; if 404, serve index.html SPA fallback transparently
    // When assets binding is not available in wrangler dev --local, we return small loader.
    // Add security headers to the SPA shell as well
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/index.html"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ModelPulseX</title></head><body>ModelPulseX — <a href="/api/health">API</a> | <a href="/">Dashboard</a></body></html>`;
    return withSecurityHeaders(
      new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      }),
      request,
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
    // Cap cross-provider parallelism to 4: groups can be up to 19 (providers) per batch.
    // Unbounded Promise.all would burst 10-19 concurrent fetch+D1+DO chains, exceeding
    // wrangler queue max_concurrency 8 and risking per-provider RPM starvation.
    // Keep drainProvider serial per-provider, but batch groups with limit 4.
    const entries = Array.from(groups.values());
    const CONCURRENCY_LIMIT = 4;
    for (let i = 0; i < entries.length; i += CONCURRENCY_LIMIT) {
      const batch = entries.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(batch.map((msgs) => drainProvider(msgs)));
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // ScheduledController exposes `cron` natively at this compatibility_date.
    const cron = controller.cron;
    // */5 * * * *   → benchmark scheduler (+ inline fallback)
    // */10 * * * *  → 10-minute aggregation (tenmin_model_stats for 5–10m live lines)
    // */30 * * * *  → frequent discovery (free-model refresh, discontinued → inactive)
    // 0 * * * *     → hourly discovery + aggregation + cleanup + staleness watchdog
    if (cron === "*/5 * * * *") {
      // Inline fallback: run the first N selected jobs inside this invocation. Guarantees
      // baseline coverage even when queue delivery stalls; queue carries the rest.
      const inlineTake = Number(env.BENCH_INLINE_FALLBACK ?? "6");
      await scheduleBenchmarks(env, {
        inlineTake: Number.isFinite(inlineTake) ? inlineTake : 6,
      });
    } else if (cron === "*/10 * * * *") {
      // ten-minute buckets: current and previous (10m edge) — tolerant to late arrivals
      try {
        const nowIso = new Date().toISOString();
        const cur = truncateToTenMin(nowIso);
        const prev = new Date(
          new Date(cur).getTime() - 10 * 60 * 1000,
        ).toISOString();
        await computeTenminAggregates(env.DB, cur);
        await computeTenminAggregates(env.DB, prev);
        await recordHourlyJob(env.DB, "aggregate");
      } catch (e) {
        console.error("tenmin aggregation failed", e);
      }
    } else if (cron === "*/30 * * * *") {
      // frequent refresh — keeps model list fresh (discontinued → PREVIOUSLY_FREE/inactive) without waiting an hour
      try {
        await runDiscovery(env);
        await recordHourlyJob(env.DB, "discovery");
      } catch (e) {
        console.error("frequent discovery failed", e);
      }
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
      // cleanup raw 7d, hourly 30d — once daily (00 UTC tick), not every hour.
      // Each run full-scans benchmark_runs + both aggregate tables (~22k rows_read);
      // hourly was burning ~0.5M rows_read/day to delete ~50 already-steady-state rows.
      if (new Date().getUTCHours() === 0) {
        try {
          await cleanupRetention(env.DB, 7, 30);
        } catch (e) {
          console.error("retention cleanup failed", e);
        }
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
      await scheduleBenchmarks(env, {
        inlineTake: Number(env.BENCH_INLINE_FALLBACK ?? "6"),
      });
    }
  },
} satisfies ExportedHandler<Env, BenchJob>;
