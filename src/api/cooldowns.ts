import { Hono } from "hono";
import type { Env } from "../types";
import { getActiveCooldowns } from "../db/cooldown";

export function cooldownsRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  // Cooldowns — per-model vs per-provider timeout display (properly distinguished)
  r.get("/cooldowns", async (c) => {
    // Edge-cache 5s shared across visitors: the dashboard polls this from two
    // components (~10s + ~12s) and remaining-time math is client-side, so a
    // few seconds of staleness is harmless.
    // SAFETY: Workers runtime exposes caches.default at runtime; DOM lib types omit it.
    const cache: Cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(c.req.url, { method: "GET" });
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      // Cache API unavailable (local dev) — fall through to D1
    }
    const data = await getActiveCooldowns(env.DB);
    // Enrich provider cooldowns with RPM usage for display
    const now = new Date().toISOString();
    const resp = c.json({
      ...data,
      now,
      meta: {
        providerCooldowns: data.providers.length,
        modelCooldowns: data.models.length,
      },
    });
    resp.headers.set(
      "Cache-Control",
      "public, max-age=15, stale-while-revalidate=30",
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
