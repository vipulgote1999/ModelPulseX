import { Hono } from "hono";
import type { Env } from "../types";
import { parseRange } from "../db/queries";
import { publicModelVisibilityWhere } from "../providers/registry";
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
    // Public view gates, shared with every by-id route via
    // publicModelVisibilityWhere so list and detail cannot drift.
    // `includeInactive=1` relaxes ONLY the active gate — the benchmark_enabled
    // and registry hard-filter gates always apply, so it can never be used to
    // read a disabled or polluted row.
    conds.push(publicModelVisibilityWhere("p", "m", { includeInactive }));
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    // FREE first: ASC puts FREE before PAID/PREVIOUSLY_FREE/UNKNOWN alphabetically.
    // Bounded so one unauthenticated request cannot stream the whole catalogue
    // out of D1.
    sql += " ORDER BY m.free_status ASC, m.last_seen DESC LIMIT 500";
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    return c.json({ models: rows.results, count: rows.results?.length ?? 0 });
  });

  // Every public by-id route runs the same visibility gate as the list routes.
  // A hidden model must 404 — identical to a genuinely absent id — so the
  // response never confirms that a paid/blacklisted row exists. Returns null
  // when the id is not a public-visible model.
  const visibleModel = async (id: number): Promise<boolean> => {
    if (!Number.isInteger(id) || id <= 0) return false;
    const row = await env.DB.prepare(
      `SELECT 1 as ok FROM models m JOIN providers p ON p.id=m.provider_id
       WHERE m.id=? AND ${publicModelVisibilityWhere("p", "m")} LIMIT 1`,
    )
      .bind(id)
      .first<{ ok: number }>();
    return !!row;
  };

  r.get("/models/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const row = await env.DB.prepare(
      "SELECT m.*, p.name as provider_name FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?",
    )
      .bind(id)
      .first();
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await visibleModel(id)))
      return c.json({ error: "not found" }, 404);
    return c.json({ model: row });
  });

  r.get("/models/:id/history", async (c) => {
    const id = Number(c.req.param("id"));
    // Reject a malformed id before any query, and gate visibility before
    // returning the full metric series. Gate first: cheaper, and it avoids
    // reading history for a row the caller may not see.
    if (!Number.isInteger(id) || id <= 0)
      return c.json({ error: "invalid id" }, 400);
    if (!(await visibleModel(id)))
      return c.json({ error: "not found" }, 404);
    const range = c.req.query("range") ?? "7d";
    const benchmark = c.req.query("benchmark") ?? "all";
    const granularity =
      c.req.query("granularity") ?? (range === "1h" ? "10m" : "hourly");
    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;
    const useTenmin = granularity === "10m";
    let rows: { results?: unknown[] } | undefined;
    // eslint-disable-next-line no-useless-assignment
    let points: unknown[] = [];
    if (useTenmin) {
      let sql =
        "SELECT bucket_start as hour_start, * FROM tenmin_model_stats WHERE model_id=? AND bucket_start >= ?";
      const binds: unknown[] = [id, since];
      if (benchmark !== "all") {
        sql += " AND benchmark_type=?";
        binds.push(benchmark);
      }
      sql += " ORDER BY bucket_start ASC";
      try {
        const r = await env.DB.prepare(sql)
          .bind(...binds)
          .all();
        points = r.results ?? [];
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes("tenmin_model_stats") ||
          msg.includes("no such table")
        ) {
          rows = await env.DB.prepare(
            "SELECT * FROM hourly_model_stats WHERE model_id=? AND hour_start >= ?" +
              (benchmark !== "all" ? " AND benchmark_type=?" : "") +
              " ORDER BY hour_start ASC",
          )
            .bind(
              ...(benchmark !== "all" ? [id, since, benchmark] : [id, since]),
            )
            .all();
          points = rows.results ?? [];
        } else throw e;
      }
    } else {
      let sql =
        "SELECT * FROM hourly_model_stats WHERE model_id=? AND hour_start >= ?";
      const binds: unknown[] = [id, since];
      if (benchmark !== "all") {
        sql += " AND benchmark_type=?";
        binds.push(benchmark);
      }
      sql += " ORDER BY hour_start ASC";
      rows = await env.DB.prepare(sql)
        .bind(...binds)
        .all();
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
    // Batch-3: /models/:id validates finite ids but /incidents did not —
    // /models/abc/incidents ran 4 queries with NaN and returned 200
    // null-uptime instead of 400. Reject up front like the sibling route.
    if (!Number.isInteger(id) || id <= 0)
      return c.json({ error: "invalid id" }, 400);
    // Same visibility gate as /models/:id and /models/:id/history: incident
    // and uptime series for a hidden row must not be publicly readable.
    if (!(await visibleModel(id)))
      return c.json({ error: "not found" }, 404);
    // NOTE: batch takes bound (unexecuted) statements; single-row reads come
    // from results[0], not .first().
    const [incidentsRes, total7Res, total24Res, longestRes] =
      await env.DB.batch([
        env.DB.prepare(
          "SELECT * FROM availability_incidents WHERE model_id=? ORDER BY started_at DESC LIMIT 100",
        ).bind(id),
        env.DB.prepare(
          "SELECT count(*) as tot, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok FROM benchmark_runs WHERE model_id=? AND started_at >= ?",
        ).bind(id, isoHoursAgo(168)),
        env.DB.prepare(
          "SELECT count(*) as tot, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok FROM benchmark_runs WHERE model_id=? AND started_at >= ?",
        ).bind(id, isoHoursAgo(24)),
        env.DB.prepare(
          "SELECT max(duration_seconds) as m FROM availability_incidents WHERE model_id=?",
        ).bind(id),
      ]);
    // SAFETY: D1 batch returns untyped rows; SELECT aliases match the shapes below.
    const total7 = (total7Res?.results?.[0] ?? null) as {
      tot: number;
      ok: number | null;
    } | null;
    const total24 = (total24Res?.results?.[0] ?? null) as {
      tot: number;
      ok: number | null;
    } | null;
    const longest = (longestRes?.results?.[0] ?? null) as {
      m: number | null;
    } | null;
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
