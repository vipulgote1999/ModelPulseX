import { Hono } from "hono";
import type { Env } from "../../types";
import { isAdmin } from "../shared";
import { escapeLikePattern, sanitizeSearchQuery } from "../../utils/security";

export function adminModelsRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/admin/models", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const provider = c.req.query("provider");
    const rawQ = c.req.query("q");
    const safeQ = sanitizeSearchQuery(rawQ, 80);
    const q = safeQ ? safeQ.toLowerCase() : null;
    const enabledFilter = c.req.query("enabled"); // "1" | "0" | undefined
    // benchmark_enabled column may not exist pre-migration — tolerate missing column
    let rows;
    try {
      let sql =
        "SELECT m.*, p.name as provider_name FROM models m JOIN providers p ON p.id=m.provider_id";
      const conds: string[] = [];
      const binds: unknown[] = [];
      if (provider) {
        conds.push("p.name=?");
        binds.push(provider);
      }
      if (enabledFilter === "1")
        conds.push("COALESCE(m.benchmark_enabled,1)=1");
      else if (enabledFilter === "0")
        conds.push("COALESCE(m.benchmark_enabled,1)=0");
      if (q) {
        const escaped = escapeLikePattern(q);
        const pattern = `%${escaped}%`;
        conds.push(
          "(lower(m.provider_model_id) LIKE ? ESCAPE '\\' OR lower(m.display_name) LIKE ? ESCAPE '\\')",
        );
        binds.push(pattern, pattern);
      }
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      sql += " ORDER BY p.name ASC, m.display_name ASC";
      rows = await env.DB.prepare(sql)
        .bind(...binds)
        .all();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("benchmark_enabled") || msg.includes("no such column")) {
        let sql2 =
          "SELECT m.*, p.name as provider_name FROM models m JOIN providers p ON p.id=m.provider_id";
        const conds2: string[] = [];
        const binds2: unknown[] = [];
        if (provider) {
          conds2.push("p.name=?");
          binds2.push(provider);
        }
        if (q) {
          const escaped2 = escapeLikePattern(q);
          const pattern2 = `%${escaped2}%`;
          conds2.push(
            "(lower(m.provider_model_id) LIKE ? ESCAPE '\\' OR lower(m.display_name) LIKE ? ESCAPE '\\')",
          );
          binds2.push(pattern2, pattern2);
        }
        if (conds2.length) sql2 += " WHERE " + conds2.join(" AND ");
        sql2 += " ORDER BY p.name ASC, m.display_name ASC";
        rows = await env.DB.prepare(sql2)
          .bind(...binds2)
          .all();
      } else throw e;
    }
    const models = (rows.results ?? []).map((r: unknown) => {
      const m = r as Record<string, unknown>;
      return {
        ...m,
        benchmark_enabled: (m["benchmark_enabled"] as number | undefined) ?? 1,
      };
    });
    return c.json({ models, count: models.length });
  });

  r.post("/admin/models/:id/toggle", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: number | boolean;
      benchmark_enabled?: number | boolean;
    };
    const raw = body.enabled ?? body.benchmark_enabled;
    let enabled: number;
    if (raw === undefined) {
      // toggle if not specified
      const row = await env.DB.prepare(
        "SELECT benchmark_enabled FROM models WHERE id=?",
      )
        .bind(id)
        .first<{ benchmark_enabled: number | null }>()
        .catch(() => null);
      const cur =
        (row as { benchmark_enabled?: number | null } | null)
          ?.benchmark_enabled ?? 1;
      enabled = cur ? 0 : 1;
    } else enabled = raw ? 1 : 0;
    try {
      await env.DB.prepare("UPDATE models SET benchmark_enabled=? WHERE id=?")
        .bind(enabled, id)
        .run();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("benchmark_enabled") || msg.includes("no such column")) {
        return c.json(
          { error: "migration 0007 not applied — run /api/admin/migrate" },
          500,
        );
      }
      throw e;
    }
    return c.json({ ok: true, id, benchmark_enabled: enabled });
  });

  r.post("/admin/models/bulk", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      ids?: number[];
      enabled?: number | boolean;
      provider?: string;
      all?: boolean;
    };
    const enabled = body.enabled ? 1 : 0;
    let ids = (body.ids ?? []).filter((n) => Number.isFinite(n));
    if (body.provider && !ids.length) {
      const rows = await env.DB.prepare(
        "SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id WHERE p.name=?",
      )
        .bind(body.provider)
        .all<{ id: number }>();
      ids = (rows.results ?? []).map((r) => r.id);
    }
    if (body.all && !ids.length) {
      const rows = await env.DB.prepare("SELECT id FROM models").all<{
        id: number;
      }>();
      ids = (rows.results ?? []).map((r) => r.id);
    }
    if (!ids.length)
      return c.json({ error: "ids or provider or all required" }, 400);
    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ph = chunk.map(() => "?").join(",");
      try {
        const r = await env.DB.prepare(
          `UPDATE models SET benchmark_enabled=? WHERE id IN (${ph})`,
        )
          .bind(enabled, ...chunk)
          .run();
        updated += r.meta.changes ?? chunk.length;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("benchmark_enabled") || msg.includes("no such column"))
          return c.json({ error: "migration 0007 not applied" }, 500);
        throw e;
      }
    }
    return c.json({ ok: true, updated, enabled });
  });
  return r;
}
