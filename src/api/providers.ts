import { Hono } from "hono";
import type { Env } from "../types";
import {
  PROVIDER_ENDPOINTS,
  PROVIDER_REGISTRY,
  freeTierFor,
} from "../providers/registry";
import { getProviderDailyUsage } from "../db/cooldown";
import {
  getConcurrency,
  capFor,
  getRPMConfig,
  rpmForProvider,
} from "../utils/concurrency";

export function providersRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/providers", async (c) => {
    // Edge-cache shared across visitors (matches the 120s browser TTL below):
    // the dashboard fetches this twice per load (filters + limit badges) and the
    // 24h-usage GROUP BY costs ~1k rows_read per origin hit.
    // SAFETY: Workers runtime exposes caches.default at runtime; DOM lib types omit it.
    const cache: Cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(c.req.url, { method: "GET" });
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      // Cache API unavailable (local dev) — fall through to D1
    }
    const [rows, dailyUsage] = await Promise.all([
      env.DB.prepare("SELECT * FROM providers ORDER BY name").all(),
      getProviderDailyUsage(env.DB),
    ]);
    // SAFETY: rpm/concurrency helpers only read string env vars and ignore D1/Queue/DO bindings.
    const rpmCfg = getRPMConfig(env as unknown as Record<string, unknown>);
    // SAFETY: same as above — string-key reads only, bindings untouched.
    const concCfg = getConcurrency(env as unknown as Record<string, unknown>);
    const enriched = (rows.results ?? []).map((r: unknown) => {
      const row = r as Record<string, unknown>;
      const name = String(row["name"] ?? "");
      const ep = PROVIDER_ENDPOINTS[name];
      const base = ep
        ? {
            ...row,
            baseUrl: ep.baseUrl,
            modelsUrl: ep.modelsUrl,
            chatUrl: ep.chatUrl,
          }
        : row;
      return {
        ...base,
        freeTier: freeTierFor(name),
        configuredRpm: rpmForProvider(name, rpmCfg),
        configuredConcurrency: capFor(name, concCfg),
        usage24h: dailyUsage.get(name) ?? 0,
      };
    });
    // Also expose registry endpoints for admin so missing/undiscovered providers still appear with URLs
    const registryEndpoints = PROVIDER_REGISTRY.map((d) => ({
      name: d.name,
      baseUrl: d.baseUrl,
      modelsUrl: d.modelsUrl,
      chatUrl: d.chatUrl,
      freeTier: d.freeTier ?? null,
      configuredRpm: rpmForProvider(d.name, rpmCfg),
      configuredConcurrency: capFor(d.name, concCfg),
      usage24h: dailyUsage.get(d.name) ?? 0,
    }));
    // 24h usage GROUP BY runs per request (~1k rows_read); provider list barely changes.
    const resp = c.json({ providers: enriched, registry: registryEndpoints });
    resp.headers.set(
      "Cache-Control",
      "public, max-age=120, stale-while-revalidate=120",
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
