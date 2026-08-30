import { Hono } from "hono";
import type { Env } from "../types";
import { parseRange } from "../db/queries";
import { freeHardFilterWhere } from "../providers/registry";
import { isoHoursAgo } from "./shared";

export function modelsRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/models", async (c) => {
    const provider = c.req.query("provider");
    const includeInactive = c.req.query("includeInactive") === "1";
    let sql =
      "SELECT m.*, p.name as provider_name FROM models m JOIN providers p ON p.id=m.provider_id";
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (provider) {
      conds.push("p.name=?");
      binds.push(provider);
    }
    if (!includeInactive) {
      conds.push("(m.active=1 OR m.free_status='PREVIOUSLY_FREE')");
    }
    // Public view: only benchmark_enabled models (disabled kept in DB but hidden from dashboard until re-enabled)
    // Tolerant fallback if column missing pre-migration
    conds.push("COALESCE(m.benchmark_enabled,1)=1");
    // Hard filters from the provider registry (single source): hide polluted rows
    // immediately, even before discovery cleanup lands.
    const modelHardFilter = freeHardFilterWhere("p", "m");
    if (modelHardFilter) conds.push(modelHardFilter.replace(/^ AND /, ""));
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY m.free_status DESC, m.last_seen DESC";
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    return c.json({ models: rows.results, count: rows.results?.length ?? 0 });
  });

  r.get("/models/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const row = await env.DB.prepare(
      "SELECT m.*, p.name as provider_name FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?",
    )
      .bind(id)
      .first();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ model: row });
  });

  r.get("/models/:id/history", async (c) => {
    const id = Number(c.req.param("id"));
    const range = c.req.query("range") ?? "7d";
    const benchmark = c.req.query("benchmark") ?? "all";
    const granularity = c.req.query("granularity") ?? (range === "1h" ? "10m" : "hourly");
    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;
    const useTenmin = granularity === "10m";
    let rows: { results?: unknown[] } | undefined;
    // eslint-disable-next-line no-useless-assignment
    let points: unknown[] = [];
    if (useTenmin) {
      let sql = "SELECT bucket_start as hour_start, * FROM tenmin_model_stats WHERE model_id=? AND bucket_start >= ?";
      const binds: unknown[] = [id, since];
      if (benchmark !== "all") {
        sql += " AND benchmark_type=?";
        binds.push(benchmark);
      }
      sql += " ORDER BY bucket_start ASC";
      try {
        const r = await env.DB.prepare(sql).bind(...binds).all();
        points = r.results ?? [];
      } catch (e) {
        const msg = String(e);
        if (msg.includes("tenmin_model_stats") || msg.includes("no such table")) {
          rows = await env.DB.prepare(
            "SELECT * FROM hourly_model_stats WHERE model_id=? AND hour_start >= ?" + (benchmark !== "all" ? " AND benchmark_type=?" : "") + " ORDER BY hour_start ASC",
          )
            .bind(...(benchmark !== "all" ? [id, since, benchmark] : [id, since]))
            .all();
          points = rows.results ?? [];
        } else throw e;
      }
    } else {
      let sql = "SELECT * FROM hourly_model_stats WHERE model_id=? AND hour_start >= ?";
      const binds: unknown[] = [id, since];
      if (benchmark !== "all") {
        sql += " AND benchmark_type=?";
        binds.push(benchmark);
      }
      sql += " ORDER BY hour_start ASC";
      rows = await env.DB.prepare(sql).bind(...binds).all();
      points = rows.results ?? [];
    }
    if (points.length === 0) {
      // Fixed: benchmark_runs has no median_tps/success_rate columns — select only correct columns
      let rawSql = `SELECT started_at as hour_start, benchmark_type, tps as avg_tps, tps as median_tps, ttft_ms as avg_ttft, ttft_ms as median_ttft, itl_ms as median_itl, itl_ms as p90_itl, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as success_rate, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as uptime, 1 as request_count FROM benchmark_runs WHERE model_id=? AND started_at >= ?`;
      const rawBinds: unknown[] = [id, since];
      if (benchmark !== "all") {
        rawSql += " AND benchmark_type=?";
        rawBinds.push(benchmark);
      }
      rawSql += " ORDER BY started_at ASC LIMIT 300";
      const raw = await env.DB.prepare(rawSql)
        .bind(...rawBinds)
        .all();
      // SAFETY: rawSql aliases its columns to exactly the HistoryPoint field names above,
      // so the untyped D1 result is structurally identical to the hourly rows view.
      points = (raw.results ?? []) as unknown as typeof points;
    }
    const cnt = await env.DB.prepare(
      "SELECT count(*) as c, min(started_at) as first FROM benchmark_runs WHERE model_id=? AND started_at >= ?",
    )
      .bind(id, since)
      .first<{ c: number; first: string | null }>();
    const hasData = (cnt?.c ?? 0) > 0;
    const windowNote = hasData
      ? `${cnt?.c} samples since ${cnt?.first}`
      : `${range} of observed data (no samples yet)`;
    return c.json({
      history: points,
      range,
      benchmark,
      meta: { observed_window: since, window_note: windowNote },
    });
  });

  r.get("/models/:id/incidents", async (c) => {
    const id = Number(c.req.param("id"));
    // Parallelize 4 independent queries — reduces I/O from 4 sequential roundtrips to 1
    const [incidentsRes, total7, total24, longest] = await Promise.all([
      env.DB.prepare(
        "SELECT * FROM availability_incidents WHERE model_id=? ORDER BY started_at DESC LIMIT 100",
      )
        .bind(id)
        .all(),
      env.DB.prepare(
        "SELECT count(*) as tot, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok FROM benchmark_runs WHERE model_id=? AND started_at >= ?",
      )
        .bind(id, isoHoursAgo(168))
        .first<{ tot: number; ok: number | null }>(),
      env.DB.prepare(
        "SELECT count(*) as tot, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok FROM benchmark_runs WHERE model_id=? AND started_at >= ?",
      )
        .bind(id, isoHoursAgo(24))
        .first<{ tot: number; ok: number | null }>(),
      env.DB.prepare(
        "SELECT max(duration_seconds) as m FROM availability_incidents WHERE model_id=?",
      )
        .bind(id)
        .first<{ m: number | null }>(),
    ]);
    return c.json({
      incidents: incidentsRes.results,
      uptime_7d: total7?.tot ? (total7.ok ?? 0) / total7.tot : null,
      uptime_24h: total24?.tot ? (total24.ok ?? 0) / total24.tot : null,
      downtime_7d: total7?.tot ? 1 - (total7.ok ?? 0) / total7.tot : null,
      incident_count: incidentsRes.results?.length ?? 0,
      longest_outage: longest?.m ?? null,
    });
  });
  return r;
}
