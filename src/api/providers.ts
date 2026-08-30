import { Hono } from "hono";
import type { Env } from "../types";
import { PROVIDER_ENDPOINTS, PROVIDER_REGISTRY } from "../providers/registry";

export function providersRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/providers", async (c) => {
    const rows = await env.DB.prepare(
      "SELECT * FROM providers ORDER BY name",
    ).all();
    const enriched = (rows.results ?? []).map((r: unknown) => {
      const row = r as Record<string, unknown>;
      const name = String(row["name"] ?? "");
      const ep = PROVIDER_ENDPOINTS[name];
      return ep
        ? {
            ...row,
            baseUrl: ep.baseUrl,
            modelsUrl: ep.modelsUrl,
            chatUrl: ep.chatUrl,
          }
        : row;
    });
    // Also expose registry endpoints for admin so missing/undiscovered providers still appear with URLs
    const registryEndpoints = PROVIDER_REGISTRY.map((d) => ({
      name: d.name,
      baseUrl: d.baseUrl,
      modelsUrl: d.modelsUrl,
      chatUrl: d.chatUrl,
    }));
    return c.json({ providers: enriched, registry: registryEndpoints });
  });
  return r;
}
