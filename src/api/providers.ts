import { Hono } from "hono";
import type { Env } from "../types";
import { PROVIDER_ENDPOINTS, PROVIDER_REGISTRY, freeTierFor } from "../providers/registry";
import { getProviderDailyUsage } from "../db/cooldown";
import { getConcurrency, capFor, getRPMConfig, rpmForProvider } from "../utils/concurrency";

export function providersRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/providers", async (c) => {
    const [rows, dailyUsage] = await Promise.all([
      env.DB.prepare("SELECT * FROM providers ORDER BY name").all(),
      getProviderDailyUsage(env.DB),
    ]);
    const rpmCfg = getRPMConfig(env as unknown as Record<string, unknown>);
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
    return c.json({ providers: enriched, registry: registryEndpoints });
  });
  return r;
}
