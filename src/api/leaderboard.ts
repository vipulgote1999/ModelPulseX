import { Hono } from "hono";
import type { Env, LeaderboardRow } from "../types";
import { parseRange } from "../db/queries";
import { scoreLeaderboard } from "../benchmark/scoring";
import { getSchedulerHealth } from "../db/health";
import { percentile, parseConcatNumbers, MIN_SAMPLES } from "../utils/metrics";
import { freeHardFilterWhere } from "../providers/registry";
import { isoHoursAgo } from "./shared";

export function leaderboardRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/leaderboard", async (c) => {
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
    const lastRunSql = `SELECT model_id, tps, ttft_ms, itl_ms, started_at, status FROM (
        SELECT model_id, tps, ttft_ms, itl_ms, started_at, status,
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
        AVG(CASE WHEN hour_start >= ? THEN median_itl END) as itl_7d,
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
        GROUP_CONCAT(CASE WHEN started_at >= ? THEN itl_ms END) as gc_itl_7d,
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
      // cnt_1h, t_1h, tt_1h | cnt_24, t_24h, tt_24h, up_24 | cnt7h, t_7d, tt_7d, itl_7d, up_7, er_7
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
      since7dIso,
      ...providerBind,
      ...(benchmarkVal ? ([benchmarkVal] as unknown[]) : []),
      since7dIso,
    ];
    // rawWindow binds: gc_tps_1h, gc_ttft_1h, cnt_1h (1h) | gc_tps_24h, gc_ttft_24h, up_24h (24h)
    //                  | gc_tps_7d, gc_ttft_7d, gc_itl_7d, up_7d, er_7d, cnt7 (7d) | cnt24 (24h)
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
      itl_7d: number | null;
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
      gc_itl_7d: string | null;
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
          itl_ms: number | null;
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
        itl_ms: number | null;
        started_at: string;
        status: string;
      }
    >();
    for (const r of lastRunsRes.results ?? []) lastMap.set(r.model_id, r as never);

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
      itl_7d: null,
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
      const itl_7d = gatedMedian(
        h.itl_7d,
        h.cnt7h,
        raw?.gc_itl_7d ?? null,
        raw?.cnt7 ?? null,
        MIN_SAMPLES.w7d,
      );
      const itl_now = nowRow?.itl_ms ?? null;
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
        itl_now,
        itl_7d,
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
  return r;
}
