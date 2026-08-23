import { Hono } from "hono";
import { cors } from "hono/cors";
import type { BenchmarkType, Env } from "../types";
import { parseRange, computeHourlyAggregates, cleanupRetention } from "../db/queries";
import { scoreLeaderboard } from "../benchmark/scoring";
import { runDiscovery } from "../benchmark/scheduler";

export function createApi(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", cors({ origin: env.CORS_ORIGIN ?? "*", allowHeaders: ["*"], allowMethods: ["*"] }));

  app.get("/api/health", (c) => {
    return c.json({ ok: true, time: new Date().toISOString(), version: "0.1.0" });
  });

  app.get("/api/providers", async (c) => {
    const rows = await env.DB.prepare("SELECT * FROM providers ORDER BY name").all();
    return c.json({ providers: rows.results });
  });

  app.get("/api/models", async (c) => {
    const provider = c.req.query("provider");
    const includeInactive = c.req.query("includeInactive") === "1";
    let sql = "SELECT m.*, p.name as provider_name FROM models m JOIN providers p ON p.id=m.provider_id";
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (provider) {
      conds.push("p.name=?");
      binds.push(provider);
    }
    if (!includeInactive) {
      // show FREE active + PREVIOUSLY_FREE last 7d retention (still visible)
      conds.push("(m.active=1 OR m.free_status='PREVIOUSLY_FREE')");
    }
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY m.free_status DESC, m.last_seen DESC";
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    return c.json({ models: rows.results, count: rows.results?.length ?? 0 });
  });

  app.get("/api/leaderboard", async (c) => {
    const range = c.req.query("range") ?? "7d";
    const provider = c.req.query("provider");
    const benchmark = c.req.query("benchmark") ?? "all"; // short|medium|coding|all
    const sort = c.req.query("sort") ?? "overall"; // overall|tps|ttft|uptime
    const profile = c.req.query("profile") ?? "balanced";

    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;

    // fetch models (free + previously_free for 7d retention) — single query
    let modelFilter = "";
    const modelBinds: unknown[] = [];
    if (provider) {
      modelFilter = "AND p.name=?";
      modelBinds.push(provider);
    }
    const modelsRes = await env.DB.prepare(
      `SELECT m.id, m.provider_model_id, m.display_name, m.free_status, m.active, p.name as provider
       FROM models m JOIN providers p ON p.id=m.provider_id
       WHERE (m.free_status='FREE' OR m.free_status='PREVIOUSLY_FREE') ${modelFilter}
       ORDER BY m.display_name`,
    )
      .bind(...modelBinds)
      .all<{ id: number; provider_model_id: string; display_name: string; free_status: string; active: number; provider: string }>();

    const models = (modelsRes.results ?? []) as Array<{ id: number; provider_model_id: string; display_name: string; free_status: string; active: number; provider: string }>;

    // early empty fast path
    if (models.length === 0) {
      const fresh = await env.DB.prepare("SELECT max(started_at) as last FROM benchmark_runs").first<{ last: string | null }>();
      const lastAgg = await env.DB.prepare("SELECT max(hour_start) as last FROM hourly_model_stats").first<{ last: string | null }>();
      const discoveryLast = await env.DB.prepare("SELECT max(last_seen) as last FROM models").first<{ last: string | null }>();
      const isStale = fresh?.last ? Date.now() - new Date(fresh.last).getTime() > 18 * 60 * 1000 : true;
      const resp = c.json({
        leaderboard: [],
        range,
        benchmark,
        sort,
        profile,
        meta: {
          last_benchmark: fresh?.last ?? null,
          last_aggregate: lastAgg?.last ?? null,
          last_discovery: discoveryLast?.last ?? null,
          is_stale: isStale,
          stale_message: isStale ? `STALE DATA Last measurement: ${fresh?.last ?? "never"}` : null,
          live: !isStale ? `● LIVE Data updated ${fresh?.last ? Math.round((Date.now() - new Date(fresh.last).getTime()) / 1000) + "s ago" : ""}` : null,
          observed_window: since,
        },
        summary: { free_models: 0, online_now: 0, best_tps: null, best_ttft: null, benchmarks_24h: 0 },
      });
      resp.headers.set("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
      return resp;
    }

    const benchmarkFilter = benchmark !== "all" ? "AND benchmark_type=?" : "";
    const benchmarkFilterHourly = benchmark !== "all" ? "AND benchmark_type=?" : "";
    const benchmarkVal = benchmark !== "all" ? benchmark : null;

    // JS-computed window bounds (ISO) to compare correctly against ISO stored strings
    const nowMs = Date.now();
    const since1h = new Date(nowMs - 1 * 3600 * 1000).toISOString();
    const since24h = new Date(nowMs - 24 * 3600 * 1000).toISOString();
    const since7dIso = new Date(nowMs - 7 * 86400 * 1000).toISOString();
    // Use subquery to avoid huge IN placeholder list (D1 max 100 params) — filter via models table directly
    const providerSubquery = provider
      ? "model_id IN (SELECT m2.id FROM models m2 JOIN providers p2 ON p2.id=m2.provider_id WHERE (m2.free_status='FREE' OR m2.free_status='PREVIOUSLY_FREE') AND p2.name=?)"
      : "model_id IN (SELECT m2.id FROM models m2 WHERE m2.free_status='FREE' OR m2.free_status='PREVIOUSLY_FREE')";
    const providerBind: unknown[] = provider ? [provider] : [];

    // Parallel batch: lastRun per model, hourly conditional agg, raw fallback, sparkline, counts, freshness
    const lastRunSql = `SELECT model_id, tps, ttft_ms, started_at, status FROM (
        SELECT model_id, tps, ttft_ms, started_at, status,
               ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY started_at DESC) as rn
        FROM benchmark_runs
        WHERE ${providerSubquery} ${benchmarkFilter}
      ) WHERE rn=1`;

    const hourlySql = `SELECT model_id,
        AVG(CASE WHEN hour_start >= ? THEN median_tps END) as t_1h,
        AVG(CASE WHEN hour_start >= ? THEN median_ttft END) as tt_1h,
        AVG(CASE WHEN hour_start >= ? THEN median_tps END) as t_24h,
        AVG(CASE WHEN hour_start >= ? THEN median_ttft END) as tt_24h,
        AVG(CASE WHEN hour_start >= ? THEN uptime END) as up_24,
        AVG(CASE WHEN hour_start >= ? THEN median_tps END) as t_7d,
        AVG(CASE WHEN hour_start >= ? THEN median_ttft END) as tt_7d,
        AVG(CASE WHEN hour_start >= ? THEN uptime END) as up_7,
        AVG(CASE WHEN hour_start >= ? THEN error_rate END) as er_7,
        SUM(CASE WHEN hour_start >= ? THEN request_count ELSE 0 END) as cnt7
      FROM hourly_model_stats
      WHERE ${providerSubquery} ${benchmarkFilterHourly} AND hour_start >= ?
      GROUP BY model_id`;

    const rawAggSql = `SELECT model_id, avg(tps) as t, avg(ttft_ms) as tt, avg(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as up, count(*) as cnt
      FROM benchmark_runs
      WHERE ${providerSubquery} AND started_at >= ? ${benchmarkFilter}
      GROUP BY model_id`;

    const sparkSql = `SELECT model_id, median_tps as v, hour_start
      FROM hourly_model_stats
      WHERE ${providerSubquery} AND hour_start >= ? ${benchmarkFilterHourly}
      ORDER BY model_id, hour_start ASC`;

    const cnt24Sql = `SELECT model_id, count(*) as c FROM benchmark_runs WHERE ${providerSubquery} AND started_at >= ? GROUP BY model_id`;

    // binds building — now tiny (no 126 ids)
    const lastRunBinds: unknown[] = [...providerBind, ...(benchmarkVal ? [benchmarkVal] : [])];
    const hourlyBinds: unknown[] = [
      since1h, since1h, since24h, since24h, since24h, since7dIso, since7dIso, since7dIso, since7dIso, since7dIso,
      ...providerBind,
      ...(benchmarkVal ? [benchmarkVal] as unknown[] : []),
      since7dIso,
    ];
    const rawBinds: unknown[] = [...providerBind, since, ...(benchmarkVal ? [benchmarkVal] : [])];
    const sparkBinds: unknown[] = [...providerBind, since24h, ...(benchmarkVal ? [benchmarkVal] : [])];
    const cnt24Binds: unknown[] = [...providerBind, since24h];

    const [
      lastRunsRes,
      hourlyRes,
      rawRes,
      sparkRes,
      cnt24Res,
      freshRes,
      lastAggRes,
      discoveryLastRes,
      benchmarks24Res,
    ] = await Promise.all([
      env.DB.prepare(lastRunSql).bind(...lastRunBinds).all<{ model_id: number; tps: number | null; ttft_ms: number | null; started_at: string; status: string }>(),
      env.DB.prepare(hourlySql).bind(...hourlyBinds).all<{ model_id: number; t_1h: number | null; tt_1h: number | null; t_24h: number | null; tt_24h: number | null; up_24: number | null; t_7d: number | null; tt_7d: number | null; up_7: number | null; er_7: number | null; cnt7: number | null }>(),
      env.DB.prepare(rawAggSql).bind(...rawBinds).all<{ model_id: number; t: number | null; tt: number | null; up: number | null; cnt: number | null }>(),
      env.DB.prepare(sparkSql).bind(...sparkBinds).all<{ model_id: number; v: number | null; hour_start: string }>(),
      env.DB.prepare(cnt24Sql).bind(...cnt24Binds).all<{ model_id: number; c: number }>(),
      env.DB.prepare("SELECT max(started_at) as last FROM benchmark_runs").first<{ last: string | null }>(),
      env.DB.prepare("SELECT max(hour_start) as last FROM hourly_model_stats").first<{ last: string | null }>(),
      env.DB.prepare("SELECT max(last_seen) as last FROM models").first<{ last: string | null }>(),
      env.DB.prepare("SELECT count(*) as c FROM benchmark_runs WHERE started_at >= datetime('now','-1 day')").first<{ c: number }>(),
    ]);

    // Build lookup maps
    const lastMap = new Map<number, { tps: number | null; ttft_ms: number | null; started_at: string; status: string }>();
    for (const r of (lastRunsRes.results ?? []) as typeof lastRunsRes.results) lastMap.set(r.model_id, r as any);

    const hourlyMap = new Map<number, { t_1h: number | null; tt_1h: number | null; t_24h: number | null; tt_24h: number | null; up_24: number | null; t_7d: number | null; tt_7d: number | null; up_7: number | null; er_7: number | null; cnt7: number | null }>();
    for (const r of (hourlyRes.results ?? []) as typeof hourlyRes.results) hourlyMap.set(r.model_id, r as any);

    const rawMap = new Map<number, { t: number | null; tt: number | null; up: number | null; cnt: number | null }>();
    for (const r of (rawRes.results ?? []) as typeof rawRes.results) rawMap.set(r.model_id, r as any);

    const sparkMap = new Map<number, Array<number | null>>();
    for (const r of (sparkRes.results ?? []) as typeof sparkRes.results) {
      const arr = sparkMap.get(r.model_id) ?? [];
      arr.push(r.v);
      sparkMap.set(r.model_id, arr);
    }
    // trim each sparkline to last 24 points already ordered ASC; keep last 24
    for (const [k, arr] of sparkMap.entries()) {
      if (arr.length > 24) sparkMap.set(k, arr.slice(-24));
    }

    const cnt24Map = new Map<number, number>();
    for (const r of (cnt24Res.results ?? []) as typeof cnt24Res.results) cnt24Map.set(r.model_id, r.c);

    const rows: unknown[] = [];
    for (const mm of models) {
      const nowRow = lastMap.get(mm.id) ?? null;
      const h = hourlyMap.get(mm.id) ?? { t_1h: null, tt_1h: null, t_24h: null, tt_24h: null, up_24: null, t_7d: null, tt_7d: null, up_7: null, er_7: null, cnt7: null };
      const raw = rawMap.get(mm.id) ?? null;

      let tps_1h = h.t_1h ?? null;
      let tps_24h = h.t_24h ?? null;
      let tps_7d = h.t_7d ?? null;
      let ttft_1h = h.tt_1h ?? null;
      let ttft_24h = h.tt_24h ?? null;
      let ttft_7d = h.tt_7d ?? null;
      let uptime_7d: number | null = h.up_7 ?? null;
      let error_rate: number | null = h.er_7 ?? null;
      let cnt7 = h.cnt7 ?? 0;

      // fallback to raw avg when aggregates missing (hourly stats may be empty for new models)
      if (tps_7d == null && raw) {
        tps_7d = tps_7d ?? raw.t ?? null;
        ttft_7d = ttft_7d ?? raw.tt ?? null;
        uptime_7d = uptime_7d ?? raw.up ?? null;
        // cnt7 remain hourly count, fallback not overriding; but if cnt7==0 use raw.cnt
        if ((cnt7 == null || cnt7 === 0) && raw.cnt != null) cnt7 = raw.cnt;
      }
      // for 1h/24h fallback from raw is not critical; keep null if missing

      const sparkline = sparkMap.get(mm.id) ?? [];
      const sampleCount24h = cnt24Map.get(mm.id) ?? 0;

      const status = (nowRow?.status as string) ?? "UNKNOWN";
      const last_test = nowRow?.started_at ?? null;

      rows.push({
        model_id: mm.id,
        model: mm.provider_model_id,
        display_name: mm.display_name,
        provider: mm.provider,
        free_status: mm.free_status,
        active: mm.active === 1,
        tps_now: nowRow?.tps ?? null,
        tps_1h,
        tps_24h,
        tps_7d,
        ttft_now: nowRow?.ttft_ms ?? null,
        ttft_1h,
        ttft_24h,
        ttft_7d,
        uptime_7d,
        error_rate_7d: error_rate,
        success_rate: uptime_7d,
        status,
        last_test,
        request_count_7d: cnt7 ?? 0,
        previously_free: mm.free_status === "PREVIOUSLY_FREE",
        measured_tps_label: "Measured TPS",
        sparkline,
        sampleCount24h,
      });
    }

    // scoring
    const scored = scoreLeaderboard(rows as any, profile);
    // sorting
    scored.sort((a: any, b: any) => {
      if (sort === "tps") return (b.tps_7d ?? b.tps_now ?? -1) - (a.tps_7d ?? a.tps_now ?? -1);
      if (sort === "ttft") return (a.ttft_7d ?? a.ttft_now ?? Infinity) - (b.ttft_7d ?? b.ttft_now ?? Infinity);
      if (sort === "uptime") return (b.uptime_7d ?? -1) - (a.uptime_7d ?? -1);
      return (b.overall_score ?? -1) - (a.overall_score ?? -1);
    });
    scored.forEach((r: any, i: number) => (r.rank = i + 1));

    // freshness
    const fresh = freshRes as { last: string | null } | null;
    const lastAgg = lastAggRes as { last: string | null } | null;
    const discoveryLast = discoveryLastRes as { last: string | null } | null;
    const benchmarks24 = benchmarks24Res as { c: number } | null;
    const isStale = fresh?.last ? Date.now() - new Date(fresh.last).getTime() > 18 * 60 * 1000 : true;

    const resp = c.json({
      leaderboard: scored,
      range,
      benchmark,
      sort,
      profile,
      meta: {
        last_benchmark: fresh?.last ?? null,
        last_aggregate: lastAgg?.last ?? null,
        last_discovery: discoveryLast?.last ?? null,
        is_stale: isStale,
        stale_message: isStale ? `STALE DATA Last measurement: ${fresh?.last ?? "never"}` : null,
        live: !isStale ? `● LIVE Data updated ${fresh?.last ? Math.round((Date.now() - new Date(fresh.last).getTime()) / 1000) + "s ago" : ""}` : null,
        observed_window: since,
      },
      summary: {
        free_models: scored.filter((r: any) => r.free_status === "FREE").length,
        online_now: scored.filter((r: any) => r.status === "SUCCESS" && r.last_test && Date.now() - new Date(r.last_test).getTime() < 10 * 60 * 1000).length,
        best_tps: scored.filter((r: any) => r.tps_now != null).sort((a: any, b: any) => b.tps_now - a.tps_now)[0] ?? null,
        best_ttft: scored.filter((r: any) => r.ttft_now != null).sort((a: any, b: any) => a.ttft_now - b.ttft_now)[0] ?? null,
        benchmarks_24h: benchmarks24?.c ?? 0,
      },
    });
    // cache: leaderboard changes every ~15s via live, but caps revalidation
    resp.headers.set("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    resp.headers.set("Vary", "Accept-Encoding");
    return resp;
  });

  // Batch history for charts — single request instead of N fetches (perf: 1 vs 4 round trips)
  app.get("/api/history", async (c) => {
    const idsParam = c.req.query("ids") ?? c.req.query("models") ?? "";
    const range = c.req.query("range") ?? "7d";
    const benchmark = c.req.query("benchmark") ?? "all";
    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;
    const ids = idsParam.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0).slice(0, 12);
    if (ids.length === 0) return c.json({ error: "ids required, e.g. ?ids=1,2,3" }, 400);
    const placeholders = ids.map(() => "?").join(",");
    let sql = `SELECT model_id, hour_start, benchmark_type, avg_tps, median_tps, p90_tps, avg_ttft, median_ttft, p90_ttft, success_rate, uptime, request_count FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ?`;
    const binds: unknown[] = [...ids, since];
    if (benchmark !== "all") { sql += " AND benchmark_type=?"; binds.push(benchmark); }
    sql += " ORDER BY model_id, hour_start ASC";
    const rows = await env.DB.prepare(sql).bind(...binds).all();
    const byModel: Record<number, unknown[]> = {};
    for (const id of ids) byModel[id] = [];
    for (const r of (rows.results ?? []) as Array<{ model_id: number } & Record<string, unknown>>) {
      (byModel[r.model_id] ??= []).push(r);
    }
    // For models with no hourly rows, fallback to raw points (so that brand new models still show something within range)
    const emptyIds = ids.filter((id) => (byModel[id] ?? []).length === 0);
    if (emptyIds.length > 0) {
      const ph2 = emptyIds.map(() => "?").join(",");
      let rawSql = `SELECT model_id, started_at as hour_start, benchmark_type, tps as avg_tps, tps as median_tps, ttft_ms as avg_ttft, ttft_ms as median_ttft, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as uptime, 1 as request_count, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as success_rate FROM benchmark_runs WHERE model_id IN (${ph2}) AND started_at >= ?`;
      const rawBinds: unknown[] = [...emptyIds, since];
      if (benchmark !== "all") { rawSql += " AND benchmark_type=?"; rawBinds.push(benchmark); }
      rawSql += " ORDER BY model_id, started_at ASC LIMIT 200";
      const raw = await env.DB.prepare(rawSql).bind(...rawBinds).all();
      for (const r of (raw.results ?? []) as Array<{ model_id: number } & Record<string, unknown>>) {
        (byModel[r.model_id] ??= []).push(r);
      }
    }
    const out: Record<number, unknown[]> = byModel;
    // Add meta note
    return c.json({ history: out, range, benchmark, meta: { observed_window: since } });
  });

  app.get("/api/models/:id", async (c) => {
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

  app.get("/api/models/:id/history", async (c) => {
    const id = Number(c.req.param("id"));
    const range = c.req.query("range") ?? "7d";
    const benchmark = c.req.query("benchmark") ?? "all";
    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;
    let sql = "SELECT * FROM hourly_model_stats WHERE model_id=? AND hour_start >= ?";
    const binds: unknown[] = [id, since];
    if (benchmark !== "all") {
      sql += " AND benchmark_type=?";
      binds.push(benchmark);
    }
    sql += " ORDER BY hour_start ASC";
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    // if no hourly but range is 1h, fallback to raw points aggregated by minute
    let points = rows.results ?? [];
    if (points.length === 0) {
      const raw = await env.DB.prepare(
        `SELECT started_at as hour_start, benchmark_type, tps as avg_tps, ttft_ms as avg_ttft, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as uptime, 1 as request_count, median_tps, success_rate FROM benchmark_runs WHERE model_id=? AND started_at >= ? ${benchmark !== "all" ? "AND benchmark_type=?" : ""} ORDER BY started_at`,
      )
        .bind(...(benchmark !== "all" ? [id, since, benchmark] : [id, since]))
        .all();
      points = (raw.results ?? []) as unknown as typeof points;
    }
    // observed window note
    const cnt = await env.DB.prepare("SELECT count(*) as c, min(started_at) as first FROM benchmark_runs WHERE model_id=? AND started_at >= ?")
      .bind(id, since)
      .first<{ c: number; first: string | null }>();
    const hasData = (cnt?.c ?? 0) > 0;
    const windowNote = hasData ? `${cnt?.c} samples since ${cnt?.first}` : `${range} of observed data (no samples yet)`;
    return c.json({ history: points, range, benchmark, meta: { observed_window: since, window_note: windowNote } });
  });

  app.get("/api/models/:id/incidents", async (c) => {
    const id = Number(c.req.param("id"));
    const rows = await env.DB.prepare("SELECT * FROM availability_incidents WHERE model_id=? ORDER BY started_at DESC LIMIT 100")
      .bind(id)
      .all();
    // compute uptime stats
    const total7 = await env.DB.prepare("SELECT count(*) as tot, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok FROM benchmark_runs WHERE model_id=? AND started_at >= datetime('now','-7 day')")
      .bind(id)
      .first<{ tot: number; ok: number }>();
    const total24 = await env.DB.prepare("SELECT count(*) as tot, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok FROM benchmark_runs WHERE model_id=? AND started_at >= datetime('now','-1 day')")
      .bind(id)
      .first<{ tot: number; ok: number }>();
    const longest = await env.DB.prepare("SELECT max(duration_seconds) as m FROM availability_incidents WHERE model_id=?").bind(id).first<{ m: number | null }>();
    return c.json({
      incidents: rows.results,
      uptime_7d: total7?.tot ? (total7.ok ?? 0) / total7.tot : null,
      uptime_24h: total24?.tot ? (total24.ok ?? 0) / total24.tot : null,
      downtime_7d: total7?.tot ? 1 - (total7.ok ?? 0) / total7.tot : null,
      incident_count: rows.results?.length ?? 0,
      longest_outage: longest?.m ?? null,
    });
  });

  app.get("/api/compare", async (c) => {
    const model = c.req.query("model"); // e.g., laguna-s-2.1
    const modelsParam = c.req.query("models"); // comma list of ids
    let ids: number[] = [];
    if (modelsParam) ids = modelsParam.split(",").map(Number).filter(Boolean);
    else if (model) {
      // fuzzy search: same base across providers
      const rows = await env.DB.prepare("SELECT id FROM models WHERE provider_model_id LIKE ? OR display_name LIKE ?").bind(`%${model}%`, `%${model}%`).all<{ id: number }>();
      ids = (rows.results ?? []).map((r) => r.id);
    }
    if (ids.length === 0) return c.json({ error: "no models matched" }, 404);
    // cap to 8 for perf
    ids = ids.slice(0, 8);
    const placeholders = ids.map(() => "?").join(",");
    // batch fetch metas + stats in parallel
    const metas = await env.DB.prepare(`SELECT m.id, m.provider_model_id, m.display_name, p.name as provider FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id IN (${placeholders})`).bind(...ids).all<{ id: number; provider_model_id: string; display_name: string; provider: string }>();
    const stats7 = await env.DB.prepare(
      `SELECT model_id, avg(median_tps) as tps_7d FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= datetime('now','-7 day') GROUP BY model_id`,
    ).bind(...ids).all<{ model_id: number; tps_7d: number | null }>();
    const raw24 = await env.DB.prepare(
      `SELECT model_id, avg(tps) as tps_24h, avg(ttft_ms) as ttft_24h FROM benchmark_runs WHERE model_id IN (${placeholders}) AND started_at >= datetime('now','-1 day') AND status='SUCCESS' GROUP BY model_id`,
    ).bind(...ids).all<{ model_id: number; tps_24h: number | null; ttft_24h: number | null }>();
    const raw7 = await env.DB.prepare(
      `SELECT model_id, avg(tps) as tps_7d_raw, avg(ttft_ms) as ttft_7d, avg(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as up7, avg(CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END) as er FROM benchmark_runs WHERE model_id IN (${placeholders}) AND started_at >= datetime('now','-7 day') GROUP BY model_id`,
    ).bind(...ids).all<{ model_id: number; tps_7d_raw: number | null; ttft_7d: number | null; up7: number | null; er: number | null }>();

    const metaMap = new Map<number, { provider_model_id: string; display_name: string; provider: string }>();
    for (const r of (metas.results ?? []) as typeof metas.results) metaMap.set(r.id, r as any);
    const s7Map = new Map<number, number | null>(); for (const r of (stats7.results ?? []) as typeof stats7.results) s7Map.set(r.model_id, r.tps_7d);
    const r24Map = new Map<number, { tps_24h: number | null; ttft_24h: number | null }>(); for (const r of (raw24.results ?? []) as typeof raw24.results) r24Map.set(r.model_id, { tps_24h: r.tps_24h, ttft_24h: r.ttft_24h });
    const r7Map = new Map<number, { tps_7d_raw: number | null; ttft_7d: number | null; up7: number | null; er: number | null}>(); for (const r of (raw7.results ?? []) as typeof raw7.results) r7Map.set(r.model_id, { tps_7d_raw: r.tps_7d_raw, ttft_7d: r.ttft_7d, up7: r.up7, er: r.er });

    const out: unknown[] = [];
    for (const id of ids) {
      const mm = metaMap.get(id);
      if (!mm) continue;
      const r24 = r24Map.get(id);
      const r7 = r7Map.get(id);
      out.push({
        model_id: id,
        provider: mm.provider,
        model: mm.provider_model_id,
        display_name: mm.display_name,
        tps_24h: r24?.tps_24h ?? null,
        tps_7d: s7Map.get(id) ?? r7?.tps_7d_raw ?? null,
        ttft_24h: r24?.ttft_24h ?? null,
        ttft_7d: r7?.ttft_7d ?? null,
        uptime_7d: r7?.up7 ?? null,
        error_rate: r7?.er ?? null,
      });
    }
    // determine winner per metric (simple max tps, min ttft)
    let recommended: unknown = null;
    if (out.length >= 2) {
      const sorted = [...(out as Array<{ tps_7d: number | null; provider: string }>)].sort((a, b) => (b.tps_7d ?? -1) - (a.tps_7d ?? -1));
      recommended = sorted[0]?.provider ?? null;
    }
    return c.json({ compare: out, recommended_provider: recommended });
  });

  // admin
  app.post("/api/admin/discover", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const r = await runDiscovery(env);
    return c.json(r);
  });
  app.post("/api/admin/benchmark", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { model_id?: number; benchmark_type?: BenchmarkType };
    if (!body.model_id) return c.json({ error: "model_id required" }, 400);
    const bt = (body.benchmark_type ?? "short") as BenchmarkType;
    const job = await env.DB.prepare("SELECT m.provider_model_id, p.name as provider, m.display_name FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?")
      .bind(body.model_id)
      .first<{ provider_model_id: string; provider: string; display_name: string }>();
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
  app.post("/api/admin/reaggregate", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    await computeHourlyAggregates(env.DB, hour.toISOString());
    return c.json({ ok: true, hour: hour.toISOString() });
  });
  app.post("/api/admin/cleanup", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    await cleanupRetention(env.DB, 7, 30);
    return c.json({ ok: true });
  });

  app.post("/api/admin/migrate", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    // Run migrations idempotently via D1 (bypasses wrangler token D1 scope issue)
    const stmts = [
      `CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE, provider_model_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL, is_free INTEGER NOT NULL DEFAULT 0, free_status TEXT NOT NULL CHECK (free_status IN ('FREE','PAID','UNKNOWN','PREVIOUSLY_FREE')), context_length INTEGER, capabilities TEXT, input_price TEXT, output_price TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(provider_id, provider_model_id))`,
      `CREATE TABLE IF NOT EXISTS benchmark_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, benchmark_type TEXT NOT NULL CHECK (benchmark_type IN ('short','medium','coding')), started_at TEXT NOT NULL, first_token_at TEXT, completed_at TEXT, input_tokens INTEGER, output_tokens INTEGER, ttft_ms REAL, generation_ms REAL, tps REAL, status TEXT NOT NULL CHECK (status IN ('SUCCESS','TIMEOUT','RATE_LIMITED','PROVIDER_ERROR','MODEL_UNAVAILABLE','STREAM_ERROR','UNKNOWN_ERROR')), error_type TEXT, http_status INTEGER, provider TEXT NOT NULL, model TEXT NOT NULL, token_estimation_method TEXT CHECK (token_estimation_method IN ('provider','heuristic')) DEFAULT 'provider')`,
      `CREATE TABLE IF NOT EXISTS hourly_model_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, hour_start TEXT NOT NULL, benchmark_type TEXT NOT NULL, avg_tps REAL, median_tps REAL, p90_tps REAL, p95_tps REAL, avg_ttft REAL, median_ttft REAL, p90_ttft REAL, p95_ttft REAL, success_rate REAL, error_rate REAL, uptime REAL, request_count INTEGER NOT NULL DEFAULT 0, UNIQUE(model_id, hour_start, benchmark_type))`,
      `CREATE TABLE IF NOT EXISTS availability_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER, reason TEXT, failure_count INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS benchmark_config (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS daily_model_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE, day_start TEXT NOT NULL, benchmark_type TEXT NOT NULL, avg_tps REAL, median_tps REAL, avg_ttft REAL, median_ttft REAL, success_rate REAL, uptime REAL, request_count INTEGER NOT NULL DEFAULT 0, UNIQUE(model_id, day_start, benchmark_type))`,
      `CREATE INDEX IF NOT EXISTS idx_models_active_free ON models(active, free_status)`,
      `CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id)`,
      `CREATE INDEX IF NOT EXISTS idx_models_last_seen ON models(last_seen)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_time ON benchmark_runs(model_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started ON benchmark_runs(started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_hourly_model_hour ON hourly_model_stats(model_id, hour_start)`,
      `CREATE INDEX IF NOT EXISTS idx_incidents_model ON availability_incidents(model_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_daily_model_day ON daily_model_stats(model_id, day_start)`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('benchmark.short.prompt', 'Return exactly: PONG', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('benchmark.medium.prompt', 'Write a concise 180-220 word summary of why observability matters for LLM APIs. Plain text only.', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('benchmark.coding.prompt', 'Implement a Python function solve(nums, target) that returns indices of two numbers adding to target. Explain complexity and provide working code with a test case. Keep output under 400 tokens.', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('retention.raw_days', '7', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('retention.hourly_days', '30', datetime('now'))`,
      `INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES ('incident.threshold', '3', datetime('now'))`,
    ];
    const results: string[] = [];
    for (const sql of stmts) {
      try { await env.DB.prepare(sql).run(); results.push("ok"); } catch (e) { results.push(String(e).slice(0,200)); }
    }
    return c.json({ ok: true, executed: results.length, results });
  });

  // admin fix inflated TPS from old engine (gen clamped to 1ms -> 8k-300k TPS)
  app.post("/api/admin/fix-tps", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    // Clamp old rows where generation was 1ms (or <20ms) and tps > 2000 — recompute with 20ms floor, and for reasoning use total wall time
    // benchmark_runs: generation_ms=1 was used for many short/medium runs with reasoning, causing 8k-300k TPS
    const upd = await env.DB.prepare(`UPDATE benchmark_runs SET tps = CASE WHEN output_tokens IS NOT NULL AND generation_ms IS NOT NULL THEN output_tokens / (MAX(generation_ms, 20) / 1000.0) ELSE tps END WHERE tps > 2000 OR generation_ms < 5`).run();
    // For reasoning-like rows (ttft > 5s and generation < 10ms), use total (ttft+generation) so TPS reflects wall time
    const upd2 = await env.DB.prepare(`UPDATE benchmark_runs SET tps = output_tokens / ((ttft_ms + generation_ms) / 1000.0) WHERE ttft_ms > 5000 AND generation_ms < 20 AND output_tokens IS NOT NULL AND (ttft_ms + generation_ms) > 0 AND tps > 1000`).run();
    // Clear hourly aggregates that were built from inflated tps (>2000 median) so next hourly cron recomputes correctly; alternatively delete them
    const delHourly = await env.DB.prepare(`DELETE FROM hourly_model_stats WHERE median_tps > 2000 OR avg_tps > 2000`).run();
    return c.json({ ok: true, updated_benchmark_runs: upd.meta.changes ?? 0, updated_reasoning: upd2.meta.changes ?? 0, deleted_hourly: delHourly.meta.changes ?? 0 });
  });

  // live SSE via DO (proxied) — DO expects /live, not /api/live
  app.get("/api/live", async (c) => {
    const stub = env.LIVE_DO.get(env.LIVE_DO.idFromName("global"));
    const req = new Request("https://live/live", { headers: { accept: "text/event-stream" } });
    return stub.fetch(req);
  });

  return app;
}

function isAdmin(c: { req: { header(n: string): string | undefined } }, env: Env): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  const auth = c.req.header("authorization") ?? "";
  const x = c.req.header("x-admin-token") ?? "";
  return auth === `Bearer ${token}` || auth === token || x === token;
}
