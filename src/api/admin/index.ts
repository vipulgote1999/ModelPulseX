import { Hono } from "hono";
import type { BenchmarkType, Env } from "../../types";
import { runDiscovery } from "../../benchmark/scheduler";
import { isAdmin } from "../shared";

export function adminRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  // ——— Admin login + model toggle (per-model benchmark_enabled) ———
  // Login verifies ADMIN_ID / ADMIN_PASSWORD (secrets) and returns the bearer token that isAdmin checks.
  // Keeps ALL discovered models stored; disabled ones simply skip scheduler queue until admin re-enables.
  r.post("/admin/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      username?: string;
      password?: string;
      pass?: string;
    };
    const id = (body.id ?? body.username ?? "").trim();
    const pass = (body.password ?? body.pass ?? "").trim();
    const expectedId = String(
      env.ADMIN_ID ??
        (env as Record<string, unknown>)["ADMIN_USERNAME"] ??
        "admin",
    ).trim();
    const expectedPass = String(env.ADMIN_PASSWORD ?? "").trim();
    const token = String(env.ADMIN_TOKEN ?? "");
    // If ADMIN_PASSWORD not set, fall back to token-as-password for backwards compat (single-secret setups)
    const passOk = expectedPass ? pass === expectedPass : pass === token;
    const idOk = id === expectedId;
    if (!idOk || !passOk) return c.json({ error: "invalid credentials" }, 401);
    if (!token) return c.json({ error: "ADMIN_TOKEN not configured" }, 500);
    return c.json({ ok: true, token });
  });

  // admin

  r.post("/admin/discover", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const r = await runDiscovery(env);
    return c.json(r);
  });
  r.post("/admin/benchmark", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      model_id?: number;
      benchmark_type?: BenchmarkType;
    };
    if (!body.model_id) return c.json({ error: "model_id required" }, 400);
    const bt = (body.benchmark_type ?? "short") as BenchmarkType;
    const job = await env.DB.prepare(
      "SELECT m.provider_model_id, p.name as provider, m.display_name FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?",
    )
      .bind(body.model_id)
      .first<{
        provider_model_id: string;
        provider: string;
        display_name: string;
      }>();
    if (!job) return c.json({ error: "model not found" }, 404);
    await env.BENCH_QUEUE.send({
      model_id: body.model_id,
      provider: job.provider,
      provider_model_id: job.provider_model_id,
      benchmark_type: bt,
      display_name: job.display_name,
    });
    return c.json({ queued: true });
  });
  return r;
}
