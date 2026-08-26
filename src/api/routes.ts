import { Hono } from "hono";
import { cors } from "hono/cors";
import type { BenchmarkType, Env, LeaderboardRow } from "../types";
import {
  parseRange,
  computeHourlyAggregates,
  cleanupRetention,
} from "../db/queries";
import { scoreLeaderboard } from "../benchmark/scoring";
import { runDiscovery } from "../benchmark/scheduler";
import { PROVIDER_ENDPOINTS, PROVIDER_REGISTRY } from "../providers/registry";
import {
  getActiveCooldowns,
  clearProviderCooldown,
  clearModelCooldown,
  clearAllCooldownsForProvider,
} from "../db/cooldown";
import { getSchedulerHealth, getLastBenchmarkAt } from "../db/health";
import { percentile, parseConcatNumbers, MIN_SAMPLES } from "../utils/metrics";
import { freeHardFilterWhere } from "../providers/registry";

/** ISO cutoff for time-window SQL — SQLite datetime('now',…) emits space-separated
 *  timestamps that string-compare BELOW ISO-'T' columns, silently widening every window
 *  to "since UTC midnight". Always compute cutoffs in JS and bind them instead. */
const isoHoursAgo = (h: number): string =>
  new Date(Date.now() - h * 3600_000).toISOString();

export function createApi(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Origin allowlist (comma-separated env override) instead of "*": the dashboard is
  // same-origin so it needs no CORS at all, and a public read-only API must never send
  // Access-Control-Allow-Origin:* alongside credential-bearing admin endpoints.
  const allowedOrigins = (
    env.CORS_ORIGIN ?? "https://modelpulsex.vipulgote5.workers.dev"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: allowedOrigins,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/api/health", async (c) => {
    const base = { ok: true, time: new Date().toISOString(), version: "0.1.0" };
    // Freshness probe for external uptime monitors: /api/health?freshness=<minutes>
    // returns 503 when the newest measurement is older than N minutes (default 15).
    // Lets UptimeRobot/BetterStack catch a stalled pipeline that plain 200s would hide.
    const freshnessParam = c.req.query("freshness");
    if (freshnessParam === undefined) return c.json(base);
    const minutes = Math.max(1, Number(freshnessParam) || 15);
    const [lastBench, sched] = await Promise.all([
      getLastBenchmarkAt(env.DB),
      getSchedulerHealth(env.DB),
    ]);
    const ageMinutes = lastBench
      ? Math.round((Date.now() - new Date(lastBench).getTime()) / 60000)
      : null;
    const fresh = ageMinutes != null && ageMinutes <= minutes;
    return c.json(
      {
        ...base,
        ok: fresh,
        fresh,
        freshness_threshold_minutes: minutes,
        last_benchmark: lastBench,
        age_minutes: ageMinutes,
        scheduler: sched,
      },
      fresh ? 200 : 503,
    );
  });

  app.get("/api/providers", async (c) => {
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

  app.get("/api/models", async (c) => {
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

  app.get("/api/leaderboard", async (c) => {
    const range = c.req.query("range") ?? "7d";
    const provider = c.req.query("provider");
    const benchmark = c.req.query("benchmark") ?? "all";
    const sort = c.req.query("sort") ?? "overall";
    const profile = c.req.query("profile") ?? "balanced";

    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;

    // fetch models (free + previously_free for 7d retention) — single query, uses idx_models_free_active_provider
    let modelFilter = "";
    const modelBinds: unknown[] = [];
    if (provider) {
      modelFilter = "AND p.name=?";
      modelBinds.push(provider);
    }
    // Hard filters straight from the provider registry (single source of truth).
    const modelHardFilter = freeHardFilterWhere("p", "m");
    const modelsRes = await env.DB.prepare(
      `SELECT m.id, m.provider_model_id, m.display_name, m.free_status, m.active, p.name as provider
       FROM models m JOIN providers p ON p.id=m.provider_id
       WHERE (m.free_status='FREE' OR m.free_status='PREVIOUSLY_FREE') AND COALESCE(m.benchmark_enabled,1)=1${modelHardFilter} ${modelFilter}
       ORDER BY m.display_name`,
    )
      .bind(...modelBinds)
      .all<{
        id: number;
        provider_model_id: string;
        display_name: string;
        free_status: string;
        active: number;
        provider: string;
      }>();

    const models = (modelsRes.results ?? []) as Array<{
      id: number;
      provider_model_id: string;
      display_name: string;
      free_status: string;
      active: number;
      provider: string;
    }>;

    // early empty fast path — single combined meta query (reduces I/O from 4 to 1 roundtrip)
    if (models.length === 0) {
      const metaRow = await env.DB.prepare(
        `SELECT (SELECT max(started_at) FROM benchmark_runs) as last_benchmark,
                (SELECT max(hour_start) FROM hourly_model_stats) as last_aggregate,
                (SELECT max(last_seen) FROM models) as last_discovery,
                (SELECT count(*) FROM benchmark_runs WHERE started_at >= ?) as benchmarks_24h`,
      )
        .bind(isoHoursAgo(24))
        .first<{
          last_benchmark: string | null;
          last_aggregate: string | null;
          last_discovery: string | null;
          benchmarks_24h: number;
        }>();
      const isStale = metaRow?.last_benchmark
        ? Date.now() - new Date(metaRow.last_benchmark).getTime() >
          18 * 60 * 1000
        : true;
      const resp = c.json({
        leaderboard: [],
        range,
        benchmark,
        sort,
        profile,
        meta: {
          last_benchmark: metaRow?.last_benchmark ?? null,
          last_aggregate: metaRow?.last_aggregate ?? null,
          last_discovery: metaRow?.last_discovery ?? null,
          is_stale: isStale,
          stale_message: isStale
            ? `STALE DATA Last measurement: ${metaRow?.last_benchmark ?? "never"}`
            : null,
          live: !isStale
            ? `● LIVE Data updated ${metaRow?.last_benchmark ? Math.round((Date.now() - new Date(metaRow.last_benchmark).getTime()) / 1000) + "s ago" : ""}`
            : null,
          observed_window: since,
        },
        summary: {
          free_models: 0,
          online_now: 0,
          best_tps: null,
          best_ttft: null,
          benchmarks_24h: metaRow?.benchmarks_24h ?? 0,
        },
      });
      resp.headers.set(
        "Cache-Control",
        "public, max-age=10, stale-while-revalidate=30",
      );
      return resp;
    }

    const benchmarkFilter = benchmark !== "all" ? "AND benchmark_type=?" : "";
    const benchmarkFilterHourly =
      benchmark !== "all" ? "AND benchmark_type=?" : "";
    const benchmarkVal = benchmark !== "all" ? benchmark : null;

    const nowMs = Date.now();
    const since1h = new Date(nowMs - 1 * 3600 * 1000).toISOString();
    const since24h = new Date(nowMs - 24 * 3600 * 1000).toISOString();
    const since7dIso = new Date(nowMs - 7 * 86400 * 1000).toISOString();
    // Hard filters straight from the provider registry (single source) for run/hour subqueries.
    const subHardFilter = freeHardFilterWhere("p2", "m2");
    const providerSubquery = provider
      ? `model_id IN (SELECT m2.id FROM models m2 JOIN providers p2 ON p2.id=m2.provider_id WHERE (m2.free_status='FREE' OR m2.free_status='PREVIOUSLY_FREE')${subHardFilter} AND p2.name=?)`
      : `model_id IN (SELECT m2.id FROM models m2 JOIN providers p2 ON p2.id=m2.provider_id WHERE (m2.free_status='FREE' OR m2.free_status='PREVIOUSLY_FREE')${subHardFilter})`;
    const providerBind: unknown[] = provider ? [provider] : [];

    // Optimized: 6 parallel queries instead of 9 — meta combined into 1, rawWindow covers 1h/24h/7d in single scan
    // Uses covering indexes: idx_benchmark_runs_model_started_type, idx_hourly_model_hour_type
    const lastRunSql = `SELECT model_id, tps, ttft_ms, started_at, status FROM (
        SELECT model_id, tps, ttft_ms, started_at, status,
               ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY started_at DESC) as rn
        FROM benchmark_runs
        WHERE ${providerSubquery} ${benchmarkFilter}
      ) WHERE rn=1`;

    const hourlySql = `SELECT model_id,
        SUM(CASE WHEN hour_start >= ? THEN request_count ELSE 0 END) as cnt_1h,
        AVG(CASE WHEN hour_start >= ? THEN median_tps END) as t_1h,
        AVG(CASE WHEN hour_start >= ? THEN median_ttft END) as tt_1h,
        SUM(CASE WHEN hour_start >= ? THEN request_count ELSE 0 END) as cnt_24,
        AVG(CASE WHEN hour_start >= ? THEN median_tps END) as t_24h,
        AVG(CASE WHEN hour_start >= ? THEN median_ttft END) as tt_24h,
        AVG(CASE WHEN hour_start >= ? THEN uptime END) as up_24,
        SUM(CASE WHEN hour_start >= ? THEN request_count ELSE 0 END) as cnt7h,
        AVG(CASE WHEN hour_start >= ? THEN median_tps END) as t_7d,
        AVG(CASE WHEN hour_start >= ? THEN median_ttft END) as tt_7d,
        AVG(CASE WHEN hour_start >= ? THEN uptime END) as up_7,
        AVG(CASE WHEN hour_start >= ? THEN error_rate END) as er_7
      FROM hourly_model_stats
      WHERE ${providerSubquery} ${benchmarkFilterHourly} AND hour_start >= ?
      GROUP BY model_id`;

    // Raw window fallback: single scan covers 1h/24h/7d when hourly aggregates are missing.
    // GROUP_CONCAT feeds JS-side MEDIANS (industry practice) instead of spike-prone averages.
    const rawWindowSql = `SELECT model_id,
        GROUP_CONCAT(CASE WHEN started_at >= ? THEN tps END) as gc_tps_1h,
        GROUP_CONCAT(CASE WHEN started_at >= ? THEN ttft_ms END) as gc_ttft_1h,
        SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) as cnt_1h,
        GROUP_CONCAT(CASE WHEN started_at >= ? THEN tps END) as gc_tps_24h,
        GROUP_CONCAT(CASE WHEN started_at >= ? THEN ttft_ms END) as gc_ttft_24h,
        AVG(CASE WHEN started_at >= ? THEN CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END END) as up_24h,
        GROUP_CONCAT(CASE WHEN started_at >= ? THEN tps END) as gc_tps_7d,
        GROUP_CONCAT(CASE WHEN started_at >= ? THEN ttft_ms END) as gc_ttft_7d,
        AVG(CASE WHEN started_at >= ? THEN CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END END) as up_7d,
        AVG(CASE WHEN started_at >= ? THEN CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END END) as er_7d,
        SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) as cnt7,
        SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) as cnt24,
        count(*) as cnt_all
      FROM benchmark_runs
      WHERE ${providerSubquery} ${benchmarkFilter}
      GROUP BY model_id`;

    // For sparkline: when benchmark=all we average across types per hour for correctness
    const sparkSql =
      benchmark === "all"
        ? `SELECT model_id, AVG(median_tps) as v, hour_start FROM hourly_model_stats WHERE ${providerSubquery} AND hour_start >= ? GROUP BY model_id, hour_start ORDER BY model_id, hour_start ASC`
        : `SELECT model_id, median_tps as v, hour_start FROM hourly_model_stats WHERE ${providerSubquery} AND hour_start >= ? ${benchmarkFilterHourly} ORDER BY model_id, hour_start ASC`;

    const metaSql = `SELECT (SELECT max(started_at) FROM benchmark_runs) as last_benchmark,
                            (SELECT max(hour_start) FROM hourly_model_stats) as last_aggregate,
                            (SELECT max(last_seen) FROM models) as last_discovery,
                            (SELECT count(*) FROM benchmark_runs WHERE started_at >= ?) as benchmarks_24h`;

    const lastRunBinds: unknown[] = [
      ...providerBind,
      ...(benchmarkVal ? [benchmarkVal] : []),
    ];
    const hourlyBinds: unknown[] = [
      // cnt_1h, t_1h, tt_1h | cnt_24, t_24h, tt_24h, up_24 | cnt7h, t_7d, tt_7d, up_7, er_7
      since1h,
      since1h,
      since1h,
      since24h,
      since24h,
      since24h,
      since24h,
      since7dIso,
      since7dIso,
      since7dIso,
      since7dIso,
      since7dIso,
      ...providerBind,
      ...(benchmarkVal ? ([benchmarkVal] as unknown[]) : []),
      since7dIso,
    ];
    // rawWindow binds: gc_tps_1h, gc_ttft_1h, cnt_1h (1h) | gc_tps_24h, gc_ttft_24h, up_24h (24h)
    //                  | gc_tps_7d, gc_ttft_7d, up_7d, er_7d, cnt7 (7d) | cnt24 (24h)
    const rawWindowBinds: unknown[] = [
      since1h,
      since1h,
      since1h,
      since24h,
      since24h,
      since24h,
      since7dIso,
      since7dIso,
      since7dIso,
      since7dIso,
      since7dIso,
      since24h,
      ...providerBind,
      ...(benchmarkVal ? [benchmarkVal] : []),
    ];
    const sparkBinds: unknown[] = [
      ...providerBind,
      since24h,
      ...(benchmarkVal ? [benchmarkVal] : []),
    ];

    interface HourlyRow {
      model_id: number;
      cnt_1h: number | null;
      t_1h: number | null;
      tt_1h: number | null;
      cnt_24: number | null;
      t_24h: number | null;
      tt_24h: number | null;
      up_24: number | null;
      cnt7h: number | null;
      t_7d: number | null;
      tt_7d: number | null;
      up_7: number | null;
      er_7: number | null;
    }
    interface RawRow {
      model_id: number;
      gc_tps_1h: string | null;
      gc_ttft_1h: string | null;
      cnt_1h: number | null;
      gc_tps_24h: string | null;
      gc_ttft_24h: string | null;
      up_24h: number | null;
      gc_tps_7d: string | null;
      gc_ttft_7d: string | null;
      up_7d: number | null;
      er_7d: number | null;
      cnt7: number | null;
      cnt24: number | null;
      cnt_all: number | null;
    }
    type MetaRow = {
      last_benchmark: string | null;
      last_aggregate: string | null;
      last_discovery: string | null;
      benchmarks_24h: number;
    };

    const [
      lastRunsRes,
      hourlyRes,
      rawWindowRes,
      sparkRes,
      metaRes,
      schedHealth,
    ] = await Promise.all([
      env.DB.prepare(lastRunSql)
        .bind(...lastRunBinds)
        .all<{
          model_id: number;
          tps: number | null;
          ttft_ms: number | null;
          started_at: string;
          status: string;
        }>(),
      env.DB.prepare(hourlySql)
        .bind(...hourlyBinds)
        .all<HourlyRow>(),
      env.DB.prepare(rawWindowSql)
        .bind(...rawWindowBinds)
        .all<RawRow>(),
      env.DB.prepare(sparkSql)
        .bind(...sparkBinds)
        .all<{ model_id: number; v: number | null; hour_start: string }>(),
      env.DB.prepare(metaSql).bind(isoHoursAgo(24)).first<MetaRow>(),
      getSchedulerHealth(env.DB),
    ]);

    const lastMap = new Map<
      number,
      {
        tps: number | null;
        ttft_ms: number | null;
        started_at: string;
        status: string;
      }
    >();
    for (const r of lastRunsRes.results ?? []) lastMap.set(r.model_id, r);

    const hourlyMap = new Map<number, HourlyRow>();
    for (const r of hourlyRes.results ?? []) hourlyMap.set(r.model_id, r);

    const rawMap = new Map<number, RawRow>();
    for (const r of rawWindowRes.results ?? []) rawMap.set(r.model_id, r);

    const sparkMap = new Map<number, Array<number | null>>();
    for (const r of sparkRes.results ?? []) {
      const arr = sparkMap.get(r.model_id) ?? [];
      arr.push(r.v);
      sparkMap.set(r.model_id, arr);
    }
    for (const [k, arr] of sparkMap.entries()) {
      if (arr.length > 24) sparkMap.set(k, arr.slice(-24));
    }

    // Median + minimum-sample gating: a window shows a number only when it has enough
    // samples to be trustworthy (prevents 1–2-sample spikes ranking #1).
    const H0: HourlyRow = {
      model_id: 0,
      cnt_1h: null,
      t_1h: null,
      tt_1h: null,
      cnt_24: null,
      t_24h: null,
      tt_24h: null,
      up_24: null,
      cnt7h: null,
      t_7d: null,
      tt_7d: null,
      up_7: null,
      er_7: null,
    };
    const gatedMedian = (
      hourlyVal: number | null,
      hourlyCnt: number | null,
      rawGc: string | null,
      rawCnt: number | null,
      min: number,
    ): number | null => {
      if (hourlyVal != null && (hourlyCnt ?? 0) >= min) return hourlyVal;
      if ((rawCnt ?? 0) >= min)
        return percentile(parseConcatNumbers(rawGc), 50);
      return null;
    };

    const rows: LeaderboardRow[] = [];
    for (const mm of models) {
      const nowRow = lastMap.get(mm.id) ?? null;
      const h = hourlyMap.get(mm.id) ?? H0;
      const raw = rawMap.get(mm.id) ?? null;

      const tps_1h = gatedMedian(
        h.t_1h,
        h.cnt_1h,
        raw?.gc_tps_1h ?? null,
        raw?.cnt_1h ?? null,
        MIN_SAMPLES.w1h,
      );
      const tps_24h = gatedMedian(
        h.t_24h,
        h.cnt_24,
        raw?.gc_tps_24h ?? null,
        raw?.cnt24 ?? null,
        MIN_SAMPLES.w24h,
      );
      const tps_7d = gatedMedian(
        h.t_7d,
        h.cnt7h,
        raw?.gc_tps_7d ?? null,
        raw?.cnt7 ?? null,
        MIN_SAMPLES.w7d,
      );
      const ttft_1h = gatedMedian(
        h.tt_1h,
        h.cnt_1h,
        raw?.gc_ttft_1h ?? null,
        raw?.cnt_1h ?? null,
        MIN_SAMPLES.w1h,
      );
      const ttft_24h = gatedMedian(
        h.tt_24h,
        h.cnt_24,
        raw?.gc_ttft_24h ?? null,
        raw?.cnt24 ?? null,
        MIN_SAMPLES.w24h,
      );
      const ttft_7d = gatedMedian(
        h.tt_7d,
        h.cnt7h,
        raw?.gc_ttft_7d ?? null,
        raw?.cnt7 ?? null,
        MIN_SAMPLES.w7d,
      );
      const samples7 = Math.max(h.cnt7h ?? 0, raw?.cnt7 ?? 0);
      const uptime_7d: number | null =
        samples7 >= MIN_SAMPLES.w7d ? (h.up_7 ?? raw?.up_7d ?? null) : null;
      const error_rate: number | null =
        samples7 >= MIN_SAMPLES.w7d ? (h.er_7 ?? raw?.er_7d ?? null) : null;
      const cnt7 = h.cnt7h ?? raw?.cnt7 ?? 0;

      const sparkline = sparkMap.get(mm.id) ?? [];
      const sampleCount24h = raw?.cnt24 ?? 0;

      const status = nowRow?.status ?? "UNKNOWN";
      const last_test = nowRow?.started_at ?? null;

      rows.push({
        rank: 0,
        model_id: mm.id,
        model: mm.provider_model_id,
        display_name: mm.display_name,
        provider: mm.provider as LeaderboardRow["provider"],
        free_status: mm.free_status as LeaderboardRow["free_status"],
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
        status: status as LeaderboardRow["status"],
        last_test,
        request_count_7d: cnt7,
        previously_free: mm.free_status === "PREVIOUSLY_FREE",
        measured_tps_label: "Measured TPS",
        sparkline,
        sampleCount24h,
        overall_score: null,
      });
    }

    const scored = scoreLeaderboard(rows, profile);
    scored.sort((a, b) => {
      if (sort === "tps")
        return (b.tps_7d ?? b.tps_now ?? -1) - (a.tps_7d ?? a.tps_now ?? -1);
      if (sort === "ttft")
        return (
          (a.ttft_7d ?? a.ttft_now ?? Infinity) -
          (b.ttft_7d ?? b.ttft_now ?? Infinity)
        );
      if (sort === "uptime") return (b.uptime_7d ?? -1) - (a.uptime_7d ?? -1);
      return (b.overall_score ?? -1) - (a.overall_score ?? -1);
    });
    scored.forEach((r, i) => (r.rank = i + 1));

    const isStale = metaRes?.last_benchmark
      ? Date.now() - new Date(metaRes.last_benchmark).getTime() > 18 * 60 * 1000
      : true;

    const resp = c.json({
      leaderboard: scored,
      range,
      benchmark,
      sort,
      profile,
      meta: {
        last_benchmark: metaRes?.last_benchmark ?? null,
        last_aggregate: metaRes?.last_aggregate ?? null,
        last_discovery: metaRes?.last_discovery ?? null,
        is_stale: isStale,
        stale_message: isStale
          ? `STALE DATA Last measurement: ${metaRes?.last_benchmark ?? "never"}`
          : null,
        live: !isStale
          ? `● LIVE Data updated ${metaRes?.last_benchmark ? Math.round((Date.now() - new Date(metaRes.last_benchmark).getTime()) / 1000) + "s ago" : ""}`
          : null,
        observed_window: since,
        scheduler: schedHealth,
      },
      summary: {
        free_models: scored.filter((r) => r.free_status === "FREE").length,
        online_now: scored.filter(
          (r) =>
            r.status === "SUCCESS" &&
            r.last_test &&
            Date.now() - new Date(r.last_test).getTime() < 10 * 60 * 1000,
        ).length,
        best_tps:
          scored
            .filter((r) => r.tps_now != null)
            .sort((a, b) => (b.tps_now ?? -1) - (a.tps_now ?? -1))[0] ?? null,
        best_ttft:
          scored
            .filter((r) => r.ttft_now != null)
            .sort(
              (a, b) => (a.ttft_now ?? Infinity) - (b.ttft_now ?? Infinity),
            )[0] ?? null,
        benchmarks_24h: metaRes?.benchmarks_24h ?? 0,
      },
    });
    resp.headers.set(
      "Cache-Control",
      "public, max-age=10, stale-while-revalidate=30",
    );
    resp.headers.set("Vary", "Accept-Encoding");
    return resp;
  });

  // Batch history for charts — single request instead of N fetches
  app.get("/api/history", async (c) => {
    const idsParam = c.req.query("ids") ?? c.req.query("models") ?? "";
    const range = c.req.query("range") ?? "7d";
    const benchmark = c.req.query("benchmark") ?? "all";
    const parsed = parseRange(range);
    if (!parsed) return c.json({ error: "invalid range" }, 400);
    const since = parsed.sinceIso;
    const ids = idsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 12);
    if (ids.length === 0)
      return c.json({ error: "ids required, e.g. ?ids=1,2,3" }, 400);
    const placeholders = ids.map(() => "?").join(",");
    let sql: string;
    let binds: unknown[];
    if (benchmark === "all") {
      // Average across benchmark_types per hour for correctness when benchmark=all
      sql = `SELECT model_id, hour_start, AVG(avg_tps) as avg_tps, AVG(median_tps) as median_tps, AVG(p90_tps) as p90_tps, AVG(avg_ttft) as avg_ttft, AVG(median_ttft) as median_ttft, AVG(p90_ttft) as p90_ttft, AVG(success_rate) as success_rate, AVG(uptime) as uptime, SUM(request_count) as request_count FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? GROUP BY model_id, hour_start ORDER BY model_id, hour_start ASC`;
      binds = [...ids, since];
    } else {
      sql = `SELECT model_id, hour_start, benchmark_type, avg_tps, median_tps, p90_tps, avg_ttft, median_ttft, p90_ttft, success_rate, uptime, request_count FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? AND benchmark_type=? ORDER BY model_id, hour_start ASC`;
      binds = [...ids, since, benchmark];
    }
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    const byModel: Record<number, unknown[]> = {};
    for (const id of ids) byModel[id] = [];
    for (const r of (rows.results ?? []) as Array<
      { model_id: number } & Record<string, unknown>
    >) {
      (byModel[r.model_id] ??= []).push(r);
    }
    const emptyIds = ids.filter((id) => (byModel[id] ?? []).length === 0);
    if (emptyIds.length > 0) {
      const ph2 = emptyIds.map(() => "?").join(",");
      let rawSql = `SELECT model_id, started_at as hour_start, benchmark_type, tps as avg_tps, tps as median_tps, ttft_ms as avg_ttft, ttft_ms as median_ttft, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as uptime, 1 as request_count, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as success_rate FROM benchmark_runs WHERE model_id IN (${ph2}) AND started_at >= ?`;
      const rawBinds: unknown[] = [...emptyIds, since];
      if (benchmark !== "all") {
        rawSql += " AND benchmark_type=?";
        rawBinds.push(benchmark);
      }
      rawSql += " ORDER BY model_id, started_at ASC LIMIT 200";
      const raw = await env.DB.prepare(rawSql)
        .bind(...rawBinds)
        .all();
      for (const r of (raw.results ?? []) as Array<
        { model_id: number } & Record<string, unknown>
      >) {
        (byModel[r.model_id] ??= []).push(r);
      }
    }
    return c.json({
      history: byModel,
      range,
      benchmark,
      meta: { observed_window: since },
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
    let sql =
      "SELECT * FROM hourly_model_stats WHERE model_id=? AND hour_start >= ?";
    const binds: unknown[] = [id, since];
    if (benchmark !== "all") {
      sql += " AND benchmark_type=?";
      binds.push(benchmark);
    }
    sql += " ORDER BY hour_start ASC";
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    let points = rows.results ?? [];
    if (points.length === 0) {
      // Fixed: benchmark_runs has no median_tps/success_rate columns — select only correct columns
      let rawSql = `SELECT started_at as hour_start, benchmark_type, tps as avg_tps, tps as median_tps, ttft_ms as avg_ttft, ttft_ms as median_ttft, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as success_rate, CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END as uptime, 1 as request_count FROM benchmark_runs WHERE model_id=? AND started_at >= ?`;
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

  app.get("/api/models/:id/incidents", async (c) => {
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

  app.get("/api/compare", async (c) => {
    const model = c.req.query("model");
    const modelsParam = c.req.query("models");
    let ids: number[] = [];
    if (modelsParam) ids = modelsParam.split(",").map(Number).filter(Boolean);
    else if (model) {
      const rows = await env.DB.prepare(
        "SELECT id FROM models WHERE provider_model_id LIKE ? OR display_name LIKE ?",
      )
        .bind(`%${model}%`, `%${model}%`)
        .all<{ id: number }>();
      ids = (rows.results ?? []).map((r) => r.id);
    }
    if (ids.length === 0) return c.json({ error: "no models matched" }, 404);
    ids = ids.slice(0, 8);
    const placeholders = ids.map(() => "?").join(",");
    const [metas, stats7, raw24, raw7] = await Promise.all([
      env.DB.prepare(
        `SELECT m.id, m.provider_model_id, m.display_name, p.name as provider FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<{
          id: number;
          provider_model_id: string;
          display_name: string;
          provider: string;
        }>(),
      env.DB.prepare(
        `SELECT model_id, avg(median_tps) as tps_7d FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? GROUP BY model_id`,
      )
        .bind(...ids, isoHoursAgo(168))
        .all<{ model_id: number; tps_7d: number | null }>(),
      env.DB.prepare(
        `SELECT model_id, avg(tps) as tps_24h, avg(ttft_ms) as ttft_24h FROM benchmark_runs WHERE model_id IN (${placeholders}) AND started_at >= ? AND status='SUCCESS' GROUP BY model_id`,
      )
        .bind(...ids, isoHoursAgo(24))
        .all<{
          model_id: number;
          tps_24h: number | null;
          ttft_24h: number | null;
        }>(),
      env.DB.prepare(
        `SELECT model_id, avg(tps) as tps_7d_raw, avg(ttft_ms) as ttft_7d, avg(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as up7, avg(CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END) as er FROM benchmark_runs WHERE model_id IN (${placeholders}) AND started_at >= ? GROUP BY model_id`,
      )
        .bind(...ids, isoHoursAgo(168))
        .all<{
          model_id: number;
          tps_7d_raw: number | null;
          ttft_7d: number | null;
          up7: number | null;
          er: number | null;
        }>(),
    ]);

    const metaMap = new Map<
      number,
      { provider_model_id: string; display_name: string; provider: string }
    >();
    for (const r of metas.results ?? []) metaMap.set(r.id, r);
    const s7Map = new Map<number, number | null>();
    for (const r of stats7.results ?? []) s7Map.set(r.model_id, r.tps_7d);
    const r24Map = new Map<
      number,
      { tps_24h: number | null; ttft_24h: number | null }
    >();
    for (const r of raw24.results ?? [])
      r24Map.set(r.model_id, { tps_24h: r.tps_24h, ttft_24h: r.ttft_24h });
    const r7Map = new Map<
      number,
      {
        tps_7d_raw: number | null;
        ttft_7d: number | null;
        up7: number | null;
        er: number | null;
      }
    >();
    for (const r of (raw7.results ?? []) as typeof raw7.results)
      r7Map.set(r.model_id, {
        tps_7d_raw: r.tps_7d_raw,
        ttft_7d: r.ttft_7d,
        up7: r.up7,
        er: r.er,
      });

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
    let recommended: unknown = null;
    if (out.length >= 2) {
      const sorted = [
        ...(out as Array<{ tps_7d: number | null; provider: string }>),
      ].sort((a, b) => (b.tps_7d ?? -1) - (a.tps_7d ?? -1));
      recommended = sorted[0]?.provider ?? null;
    }
    return c.json({ compare: out, recommended_provider: recommended });
  });

  // Cooldowns — per-model vs per-provider timeout display (properly distinguished)
  app.get("/api/cooldowns", async (c) => {
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

  // ——— Admin login + model toggle (per-model benchmark_enabled) ———
  // Login verifies ADMIN_ID / ADMIN_PASSWORD (secrets) and returns the bearer token that isAdmin checks.
  // Keeps ALL discovered models stored; disabled ones simply skip scheduler queue until admin re-enables.
  app.post("/api/admin/login", async (c) => {
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

  app.get("/api/admin/models", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const provider = c.req.query("provider");
    const q = c.req.query("q")?.trim().toLowerCase();
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
        conds.push(
          "(lower(m.provider_model_id) LIKE ? OR lower(m.display_name) LIKE ?)",
        );
        binds.push(`%${q}%`, `%${q}%`);
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
          conds2.push(
            "(lower(m.provider_model_id) LIKE ? OR lower(m.display_name) LIKE ?)",
          );
          binds2.push(`%${q}%`, `%${q}%`);
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

  app.post("/api/admin/models/:id/toggle", async (c) => {
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

  app.post("/api/admin/models/bulk", async (c) => {
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

  // admin

  app.post("/api/admin/discover", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const r = await runDiscovery(env);
    return c.json(r);
  });
  app.post("/api/admin/benchmark", async (c) => {
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

  app.post("/api/admin/cooldown/reset", async (c) => {
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

  app.post("/api/admin/migrate", async (c) => {
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

  app.post("/api/admin/fix-tps", async (c) => {
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

  app.get("/api/live", async () => {
    const stub = env.LIVE_DO.get(env.LIVE_DO.idFromName("global"));
    const req = new Request("https://live/live", {
      headers: { accept: "text/event-stream" },
    });
    return stub.fetch(req);
  });

  return app;
}

function isAdmin(
  c: { req: { header(n: string): string | undefined } },
  env: Env,
): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  const auth = c.req.header("authorization") ?? "";
  const x = c.req.header("x-admin-token") ?? "";
  return auth === `Bearer ${token}` || auth === token || x === token;
}
