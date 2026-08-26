import { fmtMs, fmtTps } from "../lib/utils";

type Props = {
  summary?: {
    free_models: number;
    online_now: number;
    best_tps: { display_name?: string; model?: string; tps_now?: number | null; tps_7d?: number | null } | null;
    best_ttft: { display_name?: string; ttft_now?: number | null; ttft_7d?: number | null } | null;
    benchmarks_24h: number;
  };
  meta?: { is_stale: boolean; live: string | null; stale_message: string | null };
  leaderboard?: Array<{ uptime_7d: number | null; overall_score: number | null }>;
};

export default function SummaryCards({ summary, meta, leaderboard }: Props) {
  const cards = [
    { label: "FREE MODELS", value: summary?.free_models ?? "—", hint: "discovered" },
    { label: "ONLINE NOW", value: summary?.online_now ?? "—", hint: "last 10m" },
    { label: "BEST TPS", value: fmtTps(summary?.best_tps?.tps_now ?? summary?.best_tps?.tps_7d ?? null), hint: summary?.best_tps?.display_name ?? summary?.best_tps?.model ?? "" },
    { label: "BEST TTFT", value: fmtMs(summary?.best_ttft?.ttft_now ?? summary?.best_ttft?.ttft_7d ?? null), hint: summary?.best_ttft?.display_name ?? "" },
    { label: "BEST RELIABILITY", value: (() => {
      const best = leaderboard?.filter((r) => r.uptime_7d != null).sort((a, b) => (b.uptime_7d ?? 0) - (a.uptime_7d ?? 0))[0];
      return best?.uptime_7d != null ? `${(best.uptime_7d * 100).toFixed(1)}%` : "—";
    })(), hint: "7d uptime" },
    { label: "BENCHMARKS / 24H", value: summary?.benchmarks_24h ?? "—", hint: meta?.is_stale ? (meta.stale_message ?? "STALE") : (meta?.live ?? "● LIVE") },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="text-[11px] tracking-widest text-zinc-500 font-semibold">{c.label}</div>
          <div className="text-xl font-semibold mt-1 mono">{String(c.value)}</div>
          <div className="text-[11px] text-zinc-500 truncate">{c.hint || "\u00A0"}</div>
        </div>
      ))}
    </div>
  );
}
