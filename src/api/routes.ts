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

    // fetch models (free + previously_free for 7d retention)
    let modelFilter = "";
    const binds: unknown[] = [since];
    if (provider) {
      modelFilter = "AND p.name=?";
      binds.push(provider);
    }
    const models = await env.DB.prepare(
      `SELECT m.id, m.provider_model_id, m.display_name, m.free_status, m.active, p.name as provider
       FROM models m JOIN providers p ON p.id=m.provider_id
       WHERE (m.free_status='FREE' OR m.free_status='PREVIOUSLY_FREE') ${modelFilter}
       ORDER BY m.display_name`,
    )
      .bind(...binds.slice(1))
      .all<{ id: number; provider_model_id: string; display_name: string; free_status: string; active: number; provider: string }>();

    const rows: unknown[] = [];
    for (const mm of (models.results ?? []) as unknown as typeof models.results) {
      // recent raw for NOW: last successful run within 1h else null
      const nowRow = await env.DB.prepare(
        `SELECT tps, ttft_ms, started_at, status FROM benchmark_runs WHERE model_id=? ${benchmark !== "all" ? "AND benchmark_type=?" : ""} ORDER BY started_at DESC LIMIT 1`,
      )
        .bind(...(benchmark !== "all" ? [mm.id, benchmark] : [mm.id]))
        .first<{ tps: number | null; ttft_ms: number | null; started_at: string; status: string }>();

      // hourly aggregates for 1h/24h/7d
      const agg1h = await env.DB.prepare(
        `SELECT avg(median_tps) as t, avg(median_ttft) as tt FROM hourly_model_stats WHERE model_id=? AND hour_start >= datetime('now','-1 hour') ${benchmark !== "all" ? "AND benchmark_type=?" : ""}`,
      )
        .bind(...(benchmark !== "all" ? [mm.id, benchmark] : [mm.id]))
        .first<{ t: number | null; tt: number | null }>();
      const agg24 = await env.DB.prepare(
        `SELECT avg(median_tps) as t, avg(median_ttft) as tt, avg(uptime) as up FROM hourly_model_stats WHERE model_id=? AND hour_start >= datetime('now','-1 day') ${benchmark !== "all" ? "AND benchmark_type=?" : ""}`,
      )
        .bind(...(benchmark !== "all" ? [mm.id, benchmark] : [mm.id]))
        .first<{ t: number | null; tt: number | null; up: number | null }>();
      const agg7 = await env.DB.prepare(
        `SELECT avg(median_tps) as t, avg(median_ttft) as tt, avg(uptime) as up, avg(error_rate) as er, sum(request_count) as cnt FROM hourly_model_stats WHERE model_id=? AND hour_start >= datetime('now','-7 day') ${benchmark !== "all" ? "AND benchmark_type=?" : ""}`,
      )
        .bind(...(benchmark !== "all" ? [mm.id, benchmark] : [mm.id]))
        .first<{ t: number | null; tt: number | null; up: number | null; er: number | null; cnt: number | null }>();

      // fallback to raw avg when aggregates empty but raw exists within 7d
      let tps_1h = agg1h?.t ?? null;
      let tps_24h = agg24?.t ?? null;
      let tps_7d = agg7?.t ?? null;
      let ttft_1h = agg1h?.tt ?? null;
      let ttft_24h = agg24?.tt ?? null;
      let ttft_7d = agg7?.tt ?? null;
      let uptime_7d: number | null = agg7?.up ?? null;
      let error_rate: number | null = agg7?.er ?? null;
      const cnt7 = agg7?.cnt ?? 0;

      // if aggregates missing, try raw aggregates
      if (tps_7d == null) {
        const rawAgg = await env.DB.prepare(
          `SELECT avg(tps) as t, avg(ttft_ms) as tt, avg(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as up, count(*) as cnt FROM benchmark_runs WHERE model_id=? AND started_at >= ? ${benchmark !== "all" ? "AND benchmark_type=?" : ""}`,
        )
          .bind(...(benchmark !== "all" ? [mm.id, since, benchmark] : [mm.id, since]))
          .first<{ t: number | null; tt: number | null; up: number | null; cnt: number | null }>();
        tps_7d = tps_7d ?? rawAgg?.t ?? null;
        ttft_7d = ttft_7d ?? rawAgg?.tt ?? null;
        uptime_7d = uptime_7d ?? rawAgg?.up ?? null;
      }

      // sparkline: last 24 hourly median_tps (TokenDyno-style trend)
      const spark = await env.DB.prepare("SELECT median_tps as v FROM hourly_model_stats WHERE model_id=? AND hour_start >= datetime('now','-1 day') ORDER BY hour_start ASC LIMIT 24")
        .bind(mm.id)
        .all<{ v: number | null }>();
      const sparkline = (spark.results ?? []).map((r) => r.v);
      // reliability sample count 24h for n= hint (like TokenDyno n= suffix)
      const cnt24 = await env.DB.prepare("SELECT count(*) as c FROM benchmark_runs WHERE model_id=? AND started_at >= datetime('now','-1 day')").bind(mm.id).first<{ c: number }>();
      const sampleCount24h = cnt24?.c ?? 0;

      // status derived from last run within 10m is SUCCESS else based on last incident
      const status = nowRow?.status ?? "UNKNOWN";
      const last_test = nowRow?.started_at ?? null;

      // Only include if we have any data or the model is previously_free with last result within 7d
      // For previously_free we still show last result even if oldest >1h
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
        // TokenDyno comparison: we store intelligence mapping front-end, but expose null here; front-end maps via getAA(model)

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

    // freshness banners helpers: last benchmark across all
    const fresh = await env.DB.prepare("SELECT max(started_at) as last FROM benchmark_runs").first<{ last: string | null }>();
    const lastAgg = await env.DB.prepare("SELECT max(hour_start) as last FROM hourly_model_stats").first<{ last: string | null }>();
    const discoveryLast = await env.DB.prepare("SELECT max(last_seen) as last FROM models").first<{ last: string | null }>();
    const isStale = fresh?.last ? Date.now() - new Date(fresh.last).getTime() > 18 * 60 * 1000 : true;

    return c.json({
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
        benchmarks_24h: await env.DB.prepare("SELECT count(*) as c FROM benchmark_runs WHERE started_at >= datetime('now','-1 day')")
          .first<{ c: number }>()
          .then((r) => r?.c ?? 0),
      },
    });
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
        `SELECT started_at as hour_start, benchmark_type, tps as avg_tps, ttft_ms as avg_ttft, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as uptime, 1 as request_count FROM benchmark_runs WHERE model_id=? AND started_at >= ? ${benchmark !== "all" ? "AND benchmark_type=?" : ""} ORDER BY started_at`,
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
    const out: unknown[] = [];
    for (const id of ids) {
      const mm = await env.DB.prepare("SELECT m.provider_model_id, m.display_name, p.name as provider FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?")
        .bind(id)
        .first<{ provider_model_id: string; display_name: string; provider: string }>();
      if (!mm) continue;
      const stats = await env.DB.prepare(
        `SELECT avg(median_tps) as tps_7d FROM hourly_model_stats WHERE model_id=? AND hour_start >= datetime('now','-7 day')`,
      )
        .bind(id)
        .first<{ tps_7d: number | null }>();
      const raw24 = await env.DB.prepare(
        `SELECT avg(tps) as tps_24h, avg(ttft_ms) as ttft_24h FROM benchmark_runs WHERE model_id=? AND started_at >= datetime('now','-1 day') AND status='SUCCESS'`,
      )
        .bind(id)
        .first<{ tps_24h: number | null; ttft_24h: number | null }>();
      const raw7 = await env.DB.prepare(
        `SELECT avg(tps) as tps_7d_raw, avg(ttft_ms) as ttft_7d, avg(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as up7, avg(CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END) as er FROM benchmark_runs WHERE model_id=? AND started_at >= datetime('now','-7 day')`,
      )
        .bind(id)
        .first<{ tps_7d_raw: number | null; ttft_7d: number | null; up7: number | null; er: number | null }>();
      out.push({
        model_id: id,
        provider: mm.provider,
        model: mm.provider_model_id,
        display_name: mm.display_name,
        tps_24h: raw24?.tps_24h ?? null,
        tps_7d: stats?.tps_7d ?? raw7?.tps_7d_raw ?? null,
        ttft_24h: raw24?.ttft_24h ?? null,
        ttft_7d: raw7?.ttft_7d ?? null,
        uptime_7d: raw7?.up7 ?? null,
        error_rate: raw7?.er ?? null,
      });
    }
    // determine winner per metric (simple max tps, min ttft)
    const withWinner = (out as Array<Record<string, unknown>>).map((e) => ({ ...e }));
    // add recommended provider (highest tps_7d among 7d)
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

  // live SSE via DO (proxied)
  app.get("/api/live", async (c) => {
    const stub = env.LIVE_DO.get(env.LIVE_DO.idFromName("global"));
    // forward request with SSE accept
    const req = new Request(c.req.url, { headers: { accept: "text/event-stream" } });
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
