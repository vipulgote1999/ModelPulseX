import { useEffect, useState, useCallback, useRef } from "react";

export interface LeaderboardResp {
  leaderboard: Array<{
    rank: number;
    model_id: number;
    model: string;
    display_name: string;
    provider: string;
    free_status: string;
    active: boolean;
    tps_now: number | null;
    tps_1h: number | null;
    tps_24h: number | null;
    tps_7d: number | null;
    ttft_now: number | null;
    ttft_1h: number | null;
    ttft_24h: number | null;
    ttft_7d: number | null;
    uptime_7d: number | null;
    error_rate_7d: number | null;
    status: string;
    last_test: string | null;
    overall_score: number | null;
    sparkline?: Array<number | null>;
    sampleCount24h?: number;
    rank_?: number;
  }>;
  meta: { last_benchmark: string | null; last_aggregate: string | null; last_discovery: string | null; is_stale: boolean; live: string | null; stale_message: string | null };
  summary: { free_models: number; online_now: number; best_tps: unknown; best_ttft: unknown; benchmarks_24h: number };
  range: string;
  benchmark: string;
  sort: string;
  profile: string;
}

export function useLeaderboard(opts: { range: string; benchmark: string; sort: string; provider?: string; profile: string }) {
  const [data, setData] = useState<LeaderboardResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const qs = new URLSearchParams({ range: opts.range, benchmark: opts.benchmark, sort: opts.sort, profile: opts.profile });
    if (opts.provider) qs.set("provider", opts.provider);
    const res = await fetch(`/api/leaderboard?${qs}`, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`leaderboard ${res.status}`);
    const j = (await res.json()) as LeaderboardResp;
    setData(j);
    setLoading(false);
    setError(null);
  }, [opts.range, opts.benchmark, opts.sort, opts.provider, opts.profile]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNow().catch((e) => {
      if ((e as Error).name === "AbortError") return;
      if (!cancelled) {
        setError(String(e));
        setLoading(false);
      }
    });
    // poll as fallback — SSE is primary; lengthen to 30s to reduce load (was 15s)
    const id = setInterval(() => fetchNow().catch(() => {}), 30000);
    // SSE live updates bump refresh (debounced)
    let es: EventSource | null = null;
    let debounce: number | null = null;
    try {
      es = new EventSource("/api/live");
      es.addEventListener("benchmark", () => {
        if (debounce) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => fetchNow().catch(() => {}), 800);
      });
      // SSE hiccups are tolerated — periodic polling refetch keeps data fresh regardless
      es.onerror = () => { /* no-op */ };
    } catch {
      // EventSource unavailable/blocked — polling fallback above still refreshes data.
    }
    return () => {
      cancelled = true;
      clearInterval(id);
      if (debounce) window.clearTimeout(debounce);
      abortRef.current?.abort();
      if (es) es.close();
    };
  }, [fetchNow]);

  return { data, loading, error, refresh: fetchNow };
}
