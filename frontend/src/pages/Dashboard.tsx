import { useMemo, useState, useEffect, lazy, Suspense, useRef } from "react";
import { useLeaderboard } from "../hooks/useLeaderboard";
import { useHistory } from "../hooks/useHistory";
import SummaryCards from "../components/SummaryCards";
import Leaderboard from "../components/Leaderboard";
import RecommendationCards from "../components/RecommendationCards";
import ChartModelSelector from "../components/ChartModelSelector";
import CooldownPanel from "../components/CooldownPanel";
import { getAA } from "../lib/intelligence";

// Lazy-recharts — cuts initial JS by ~250KB (recharts only parsed when charts viewport needed)
const TpsChart = lazy(() => import("../charts/TpsChart"));
const TtftChart = lazy(() => import("../charts/TtftChart"));
const ItlChart = lazy(() => import("../charts/ItlChart"));
const ReliabilityChart = lazy(() => import("../charts/ReliabilityChart"));
const ComparePanel = lazy(() => import("../components/ComparePanel"));

function ChartFallback() {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-500 animate-pulse">Loading chart…</div>;
}

export default function Dashboard() {
  const [range, setRange] = useState("7d");
  const [benchmark, setBenchmark] = useState("all");
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState("overall");
  const [profile, setProfile] = useState("balanced");
  const [selected, setSelected] = useState<number[]>([]);
  const [providers, setProviders] = useState<Array<{ name: string }>>([]);

  useEffect(() => {
    fetch("/api/providers").then(r=>r.json()).then((j: unknown)=>setProviders(((j as { providers?: Array<{name:string}> }).providers??[]) as Array<{name:string}>)).catch(()=>{});
  }, []);

  const { data, loading, error } = useLeaderboard({ range, benchmark, sort, provider, profile });
  const rows = data?.leaderboard ?? [];

  // Default chart selection = top 3 by Intelligence (AA score) then overall_score (user wants best AI first)
  const defaultIds = useMemo(() => {
    if (rows.length === 0) return [];
    const ranked = [...rows].sort((a, b) => {
      const aa = getAA(a.model)?.score ?? -1;
      const bb = getAA(b.model)?.score ?? -1;
      if (aa !== bb) return bb - aa;
      return (b.overall_score ?? -1) - (a.overall_score ?? -1);
    });
    return ranked.slice(0, 3).map((r) => r.model_id);
  }, [rows]);

  // Auto-apply default once when rows first load and nothing selected yet
  const hasAutoSelected = useRef(false);
  useEffect(() => {
    if (rows.length > 0 && selected.length === 0 && defaultIds.length > 0 && !hasAutoSelected.current) {
      hasAutoSelected.current = true;
      setSelected(defaultIds);
    }
    // reset guard if provider/range changes cause rows to empty then reload
    if (rows.length === 0) hasAutoSelected.current = false;
  }, [rows, defaultIds, selected.length]);

  // chartIds = explicit selection (max 3) else default top-intelligence (so graphs never empty when data exists)
  const chartIds = useMemo(() => {
    if (selected.length > 0) return selected.slice(0, 3);
    return defaultIds;
  }, [selected, defaultIds]);

  // Only fetch history when rows ready
  const historyIds = useMemo(() => {
    if (rows.length === 0) return [];
    return chartIds;
  }, [rows.length, chartIds]);
  const history = useHistory(historyIds, range, benchmark);

  const tpsSeries = useMemo(() => {
    return chartIds
      .map((id) => {
        const meta = rows.find((r) => r.model_id === id);
        const label = meta ? `${meta.display_name.slice(0, 18)} · ${meta.provider}` : String(id);
        // SAFETY: history Point comes from D1 JSON with hourly or tenmin columns; untyped rows may have only avg_tps or median_tps, so fallback is safe
        return { id, label, points: (history.data[id] ?? []).map((p) => ({ hour_start: p.hour_start, median_tps: (p as unknown as { median_tps: number | null }).median_tps ?? (p as unknown as { avg_tps: number | null }).avg_tps ?? null })) };
      })
      .filter((s) => s.points.length > 0);
  }, [history.data, chartIds, rows]);

  const ttftSeries = useMemo(() => {
    return chartIds
      .map((id) => {
        const meta = rows.find((r) => r.model_id === id);
        const label = meta ? `${meta.display_name.slice(0, 18)} · ${meta.provider}` : String(id);
        // SAFETY: ttft columns may be avg_ttft-only on fallback rows; coalesce to median_ttft safely
        return { id, label, points: (history.data[id] ?? []).map((p) => ({ hour_start: p.hour_start, median_ttft: (p as unknown as { median_ttft: number | null }).median_ttft ?? (p as unknown as { avg_ttft: number | null }).avg_ttft ?? null })) };
      })
      .filter((s) => s.points.length > 0);
  }, [history.data, chartIds, rows]);

  const itlSeries = useMemo(() => {
    return chartIds
      .map((id) => {
        const meta = rows.find((r) => r.model_id === id);
        const label = meta ? `${meta.display_name.slice(0, 18)} · ${meta.provider}` : String(id);
        // SAFETY: median_itl may be null for old aggregates; cast is safe for D1 untyped row
        return { id, label, points: (history.data[id] ?? []).map((p) => ({ hour_start: p.hour_start, median_itl: (p as unknown as { median_itl: number | null }).median_itl ?? null })) };
      })
      .filter((s) => s.points.length > 0);
  }, [history.data, chartIds, rows]);

  const reliabilityModels = useMemo(() => {
    const ids = chartIds;
    return ids.map((id) => {
      const meta = rows.find((r) => r.model_id === id);
      // SAFETY: success_rate/uptime aliasing from raw benchmark_runs fallback vs aggregates
      return { display_name: meta?.display_name ?? String(id), provider: meta?.provider ?? "", points: (history.data[id] ?? []).map((p) => ({ hour_start: p.hour_start, success_rate: (p as unknown as { success_rate: number | null }).success_rate ?? (p as unknown as { uptime: number | null }).uptime ?? null })) };
    });
  }, [history.data, chartIds, rows]);

  if (loading) return (
    <div className="max-w-[1400px] mx-auto px-4 py-10 space-y-4">
      <div className="h-6 w-64 bg-zinc-800 animate-pulse rounded" />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({length:6}).map((_,i)=><div key={i} className="h-24 bg-zinc-900 animate-pulse rounded-xl border border-zinc-800" />)}
      </div>
      <div className="h-[400px] bg-zinc-900 animate-pulse rounded-xl border border-zinc-800" />
      <p className="text-sm text-zinc-500">Loading leaderboard… checking free models from all configured providers.</p>
    </div>
  );
  if (error) return <div className="max-w-[1400px] mx-auto px-4 py-10 text-amber-300">Failed to load: {String(error)} — try refresh. Discovery runs hourly; queue may be catching up. API: <a className="underline" href="/api/health">/api/health</a></div>;

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* freshness */}
      <div className={`rounded-lg border px-3 py-2 text-sm flex flex-wrap gap-3 items-center ${data?.meta.is_stale ? "bg-amber-950/40 border-amber-800 text-amber-200" : "bg-emerald-950/30 border-emerald-800 text-emerald-200"}`}>
        <span className="font-semibold">{data?.meta.is_stale ? (data?.meta.stale_message ?? "STALE DATA") : (data?.meta.live ?? "● LIVE")}</span>
        <span className="text-zinc-400">Last benchmark: {data?.meta.last_benchmark ? new Date(data.meta.last_benchmark).toLocaleString() : "never"} · Last aggregate: {data?.meta.last_aggregate ? new Date(data.meta.last_aggregate).toLocaleString() : "—"} · Last discovery: {data?.meta.last_discovery ? new Date(data.meta.last_discovery).toLocaleString() : "—"}</span>
        <span className="ml-auto text-[11px] text-zinc-500">{rows.length ? `${rows.length} models · ${data?.range} ${data?.benchmark} sort:${data?.sort} profile:${data?.profile}` : ""}</span>
      </div>

      {/* SAFETY: API responses are untyped JSON; narrow summary/meta/leaderboard shapes safely for display */}
      <SummaryCards summary={data?.summary as unknown as { free_models: number; online_now: number; best_tps: { display_name?: string; model?: string; tps_now?: number | null; tps_7d?: number | null } | null; best_ttft: { display_name?: string; ttft_now?: number | null; ttft_7d?: number | null } | null; benchmarks_24h: number }} meta={data?.meta as unknown as { is_stale: boolean; live: string | null; stale_message: string | null }} leaderboard={rows as unknown as Array<{ uptime_7d: number | null; overall_score: number | null }>} />

      {/* controls */}
      <div className="flex flex-wrap gap-2 items-center">
        <select value={range} onChange={(e) => setRange(e.target.value)} className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-sm">
          <option value="1h">1h</option><option value="24h">24h</option><option value="3d">3d</option><option value="7d">7d</option>
        </select>
        <select value={benchmark} onChange={(e) => setBenchmark(e.target.value)} className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-sm">
          <option value="all">All benchmarks</option><option value="short">Short</option><option value="medium">Medium</option><option value="coding">Coding</option>
        </select>
        <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value || undefined)} className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-sm">
          <option value="">All providers</option>
          {providers.map(p=> <option key={p.name} value={p.name}>{p.name}</option>)}
          {/* fallback static when providers not yet loaded */}
          {providers.length===0 && <>
            <option value="opencode_zen">opencode_zen</option>
            <option value="openrouter">openrouter</option>
            <option value="groq">groq</option>
            <option value="cerebras">cerebras</option>
            <option value="gemini">gemini</option>
            <option value="nvidia">nvidia</option>
            <option value="sambanova">sambanova</option>
            <option value="mistral">mistral</option>
            <option value="agnes_ai">agnes_ai</option>
            <option value="aionlabs">aionlabs</option>
            <option value="kilocode">kilocode</option>
            <option value="glhf">glhf</option>
            <option value="nscale">nscale</option>
            <option value="speka">speka</option>
            <option value="nexaapi">nexaapi</option>
            <option value="orcarouter">orcarouter</option>
            <option value="ninerouter">ninerouter</option>
            <option value="tokenrouter">tokenrouter</option>
            <option value="ollama">ollama</option>
          </>}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-sm">
          <option value="overall">Overall Score</option><option value="tps">Fastest (TPS)</option><option value="ttft">Lowest TTFT</option><option value="uptime">Most Reliable</option>
        </select>
        <select value={profile} onChange={(e) => setProfile(e.target.value)} className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-sm">
          <option value="balanced">Balanced</option><option value="fastest">Fastest</option><option value="latency">Lowest Latency</option><option value="reliable">Most Reliable</option><option value="coding">Coding</option>
        </select>
        <span className="text-xs text-zinc-500 ml-auto hidden lg:inline">Measured TPS (not provider-reported) · TTFT = first_token - started · {range === "1h" ? "1h → 10m buckets (6 points)" : "range affects charts (hourly aggregates)"}</span>
      </div>

      {/* SAFETY: rows are LeaderboardRow[] widened for card props; safe structural subset */}
      <RecommendationCards rows={rows as unknown as Array<{ display_name: string; model: string; provider: string; tps_now: number | null; ttft_now: number | null; uptime_7d: number | null; overall_score: number | null }>} />

      <CooldownPanel />

      <div>
        <div className="text-sm font-semibold mb-2">Live leaderboard — click rows to pin for graph comparison (max 3) · sorted by {String(sort)} · {rows.length} models</div>
        {/* SAFETY: Leaderboard expects Row shape; rows are LeaderboardRow[] narrowed to displayed columns safely */}
        <Leaderboard rows={rows as unknown as Array<{ rank: number; model_id: number; model: string; display_name: string; provider: string; free_status: string; active: boolean; tps_now: number | null; tps_1h: number | null; tps_24h: number | null; tps_7d: number | null; ttft_now: number | null; ttft_7d: number | null; itl_now: number | null; itl_7d: number | null; uptime_7d: number | null; error_rate_7d: number | null; status: string; last_test: string | null; overall_score: number | null }>} onSelect={setSelected} selected={selected} />
      </div>

      {/* SAFETY: ChartModelSelector expects minimal Row subset; safe projection */}
      <ChartModelSelector rows={rows as unknown as Array<{ model_id: number; model: string; display_name: string; provider: string; tps_now: number | null; overall_score: number | null }>} selected={selected} onChange={setSelected} />

      <Suspense fallback={<ChartFallback />}>
        <TpsChart series={tpsSeries} range={range} />
      </Suspense>
      <Suspense fallback={<ChartFallback />}>
        <TtftChart series={ttftSeries} range={range} />
      </Suspense>
      <Suspense fallback={<ChartFallback />}>
        <ItlChart series={itlSeries} range={range} />
      </Suspense>

      <Suspense fallback={<ChartFallback />}>
        <ReliabilityChart models={reliabilityModels} />
      </Suspense>

      <Suspense fallback={<ChartFallback />}>
        <ComparePanel selected={chartIds.length ? chartIds : defaultIds.slice(0, 2)} />
      </Suspense>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-xs text-zinc-500">
        <b className="text-zinc-300">Only necessary data stored:</b> raw benchmark_runs 7–14d TTL, hourly aggregates 30–90d, incidents/model metadata indefinite. No response bodies. If a model leaves FREE (goes paid), it shows <span className="text-amber-300">Previously Free</span> with its last 7d results frozen until TTL, per spec.
      </div>
    </div>
  );
}
