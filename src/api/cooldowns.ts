import { Hono } from "hono";
import type { Env } from "../types";
import { getActiveCooldowns } from "../db/cooldown";

export function cooldownsRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  // Cooldowns — per-model vs per-provider timeout display (properly distinguished)
  r.get("/cooldowns", async (c) => {
    const data = await getActiveCooldowns(env.DB);
    // Enrich provider cooldowns with RPM usage for display
    const now = new Date().toISOString();
    return c.json({
      ...data,
      now,
      meta: {
        providerCooldowns: data.providers.length,
        modelCooldowns: data.models.length,
      },
    });
  });
  return r;
}
