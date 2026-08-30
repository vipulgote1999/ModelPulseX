import { Hono } from "hono";
import type { Env } from "../../types";
import {
  computeHourlyAggregates,
  cleanupRetention,
} from "../../db/queries";
import {
  getActiveCooldowns,
  clearProviderCooldown,
  clearModelCooldown,
  clearAllCooldownsForProvider,
} from "../../db/cooldown";
import { isAdmin } from "../shared";

export function adminMaintenanceRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.post("/admin/reaggregate", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    await computeHourlyAggregates(env.DB, hour.toISOString());
    return c.json({ ok: true, hour: hour.toISOString() });
  });
  r.post("/admin/cleanup", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    await cleanupRetention(env.DB, 7, 30);
    return c.json({ ok: true });
  });

  r.post("/admin/cooldown/reset", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      provider?: string;
      model_id?: number;
      clearAll?: boolean;
    };
    let cleared: number;
    if (body.model_id) {
      await clearModelCooldown(env.DB, Number(body.model_id));
      cleared = 1;
    } else if (body.provider) {
      if (body.clearAll) {
        await clearAllCooldownsForProvider(env.DB, body.provider);
        // provider row deleted above; also count models still listed as cooling pre-clear
        const after = await getActiveCooldowns(env.DB);
        cleared = 1 + after.models.length; // approximate
      } else {
        await clearProviderCooldown(env.DB, body.provider);
        cleared = 1;
      }
    } else {
      const before = await getActiveCooldowns(env.DB);
      for (const p of before.providers)
        await clearProviderCooldown(env.DB, p.provider);
      for (const m of before.models)
        await clearModelCooldown(env.DB, m.model_id);
      cleared = before.providers.length + before.models.length;
    }
    return c.json({ ok: true, cleared });
  });

  r.post("/admin/migrate", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const stmts = [
      `CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE, provider_model_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL, is_free INTEGER NOT NULL DEFAULT 0, free_status TEXT NOT NULL CHECK (free_status IN ('FREE','PAID','UNKNOWN','PREVIOUSLY_FREE')), context_length INTEGER, capabilities TEXT, input_price TEXT, output_price TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(provider_id, provider_model_id))`,
      `CREATE TABLE IF NOT EXISTS benchmark_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, benchmark_type TEXT NOT NULL CHECK (benchmark_type IN ('short','medium','coding')), started_at TEXT NOT NULL, first_token_at TEXT, completed_at TEXT, input_tokens INTEGER, output_tokens INTEGER, ttft_ms REAL, generation_ms REAL, tps REAL, status TEXT NOT NULL CHECK (status IN ('SUCCESS','TIMEOUT','RATE_LIMITED','PROVIDER_ERROR','MODEL_UNAVAILABLE','STREAM_ERROR','UNKNOWN_ERROR')), error_type TEXT, http_status INTEGER, provider TEXT NOT NULL, model TEXT NOT NULL, token_estimation_method TEXT CHECK (token_estimation_method IN ('provider','heuristic')) DEFAULT 'provider')`,
      `CREATE TABLE IF NOT EXISTS hourly_model_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, hour_start TEXT NOT NULL, benchmark_type TEXT NOT NULL, avg_tps REAL, median_tps REAL, p90_tps REAL, p95_tps REAL, avg_ttft REAL, median_ttft REAL, p90_ttft REAL, p95_ttft REAL, success_rate REAL, error_rate REAL, uptime REAL, request_count INTEGER NOT NULL DEFAULT 0, UNIQUE(model_id, hour_start, benchmark_type))`,
      `CREATE TABLE IF NOT EXISTS availability_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER, reason TEXT, failure_count INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS benchmark_config (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS daily_model_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, day_start TEXT NOT NULL, benchmark_type TEXT NOT NULL, avg_tps REAL, median_tps REAL, avg_ttft REAL, median_ttft REAL, success_rate REAL, uptime REAL, request_count INTEGER NOT NULL DEFAULT 0, UNIQUE(model_id, day_start, benchmark_type))`,
      `CREATE TABLE IF NOT EXISTS provider_cooldowns (provider TEXT PRIMARY KEY, cooldown_until TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS model_cooldowns (model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE, cooldown_until TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_models_active_free ON models(active, free_status)`,
      `CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id)`,
      `CREATE INDEX IF NOT EXISTS idx_models_last_seen ON models(last_seen)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_time ON benchmark_runs(model_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started ON benchmark_runs(started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_hourly_model_hour ON hourly_model_stats(model_id, hour_start)`,
      `CREATE INDEX IF NOT EXISTS idx_incidents_model ON availability_incidents(model_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_daily_model_day ON daily_model_stats(model_id, day_start)`,
      // 0004 optimizations
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started_type ON benchmark_runs(started_at, benchmark_type)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_started_type ON benchmark_runs(model_id, started_at, benchmark_type)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_provider_model ON benchmark_runs(provider, model)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_status_time ON benchmark_runs(model_id, status, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_hourly_hour_type ON hourly_model_stats(hour_start, benchmark_type)`,
      `CREATE INDEX IF NOT EXISTS idx_hourly_model_hour_type ON hourly_model_stats(model_id, hour_start, benchmark_type)`,
      `CREATE INDEX IF NOT EXISTS idx_models_free_active_provider ON models(free_status, active, provider_id)`,
      `CREATE INDEX IF NOT EXISTS idx_models_provider_model ON models(provider_id, provider_model_id)`,
      `CREATE INDEX IF NOT EXISTS idx_incidents_open ON availability_incidents(model_id, ended_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_cooldowns_until ON model_cooldowns(cooldown_until)`,
      `CREATE INDEX IF NOT EXISTS idx_provider_cooldowns_until ON provider_cooldowns(cooldown_until)`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('benchmark.short.prompt', 'Return exactly: PONG', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('benchmark.medium.prompt', 'Write a concise 180-220 word summary of why observability matters for LLM APIs. Plain text only.', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('benchmark.coding.prompt', 'Implement a Python function solve(nums, target) that returns indices of two numbers adding to target. Explain complexity and provide working code with a test case. Keep output under 400 tokens.', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('retention.raw_days', '7', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('retention.hourly_days', '30', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('incident.threshold', '3', datetime('now'))`,
    ];
    const results: string[] = [];
    for (const sql of stmts) {
      try {
        await env.DB.prepare(sql).run();
        results.push("ok");
      } catch (e) {
        results.push(String(e).slice(0, 200));
      }
    }
    return c.json({ ok: true, executed: results.length, results });
  });

  r.post("/admin/fix-tps", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const upd = await env.DB.prepare(
      `UPDATE benchmark_runs SET tps = CASE WHEN output_tokens IS NOT NULL AND generation_ms IS NOT NULL THEN output_tokens / (MAX(generation_ms, 20) / 1000.0) ELSE tps END WHERE tps > 2000 OR generation_ms < 5`,
    ).run();
    const upd2 = await env.DB.prepare(
      `UPDATE benchmark_runs SET tps = output_tokens / ((ttft_ms + generation_ms) / 1000.0) WHERE ttft_ms > 5000 AND generation_ms < 20 AND output_tokens IS NOT NULL AND (ttft_ms + generation_ms) > 0 AND tps > 1000`,
    ).run();
    const delHourly = await env.DB.prepare(
      `DELETE FROM hourly_model_stats WHERE median_tps > 2000 OR avg_tps > 2000`,
    ).run();
    return c.json({
      ok: true,
      updated_benchmark_runs: upd.meta.changes ?? 0,
      updated_reasoning: upd2.meta.changes ?? 0,
      deleted_hourly: delHourly.meta.changes ?? 0,
    });
  });
  return r;
}
