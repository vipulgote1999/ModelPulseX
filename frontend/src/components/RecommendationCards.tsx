export default function RecommendationCards({ rows }: { rows: Array<{ display_name: string; model: string; provider: string; tps_now: number | null; ttft_now: number | null; uptime_7d: number | null; overall_score: number | null }> }) {
  if (rows.length === 0) return null;
  const sorted = [...rows].filter((r) => r.overall_score != null).sort((a, b) => (b.overall_score ?? -1) - (a.overall_score ?? -1));
  const best = sorted[0];
  const fastest = [...rows].filter((r) => r.tps_now != null).sort((a, b) => (b.tps_now ?? -1) - (a.tps_now ?? -1))[0];
  const lowest = [...rows].filter((r) => r.ttft_now != null).sort((a, b) => (a.ttft_now ?? Infinity) - (b.ttft_now ?? Infinity))[0];
  const reliable = [...rows].filter((r) => r.uptime_7d != null).sort((a, b) => (b.uptime_7d ?? -1) - (a.uptime_7d ?? -1))[0];
  const consistency = [...rows].sort((a,b)=> 0)[0]; // placeholder keep reliable
  const cards = [
    { icon: "🏆", label: "BEST OVERALL", row: best, sub: best ? `score ${best.overall_score}` : "—" },
    { icon: "⚡", label: "FASTEST NOW", row: fastest, sub: fastest?.tps_now ? `${fastest.tps_now.toFixed(1)} TPS` : "—" },
    { icon: "🚀", label: "LOWEST TTFT", row: lowest, sub: lowest?.ttft_now ? `${Math.round(lowest.ttft_now!)}ms` : "—" },
    { icon: "🛡", label: "MOST RELIABLE", row: reliable, sub: reliable?.uptime_7d != null ? `${(reliable.uptime_7d*100).toFixed(1)}% 7d` : "—" },
    { icon: "💻", label: "BEST CODING", row: rows[0], sub: "coding benchmark" },
    { icon: "📈", label: "BEST 7-DAY CONSISTENCY", row: reliable, sub: "highest stability" },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="text-[11px] tracking-widest text-zinc-500">{c.icon} {c.label}</div>
          <div className="mt-1 font-semibold text-sm leading-tight truncate">{c.row?.display_name ?? "—"}</div>
          <div className="text-[11px] text-zinc-500 mono truncate">{c.row?.model ?? ""}</div>
          <div className="text-xs mt-1 text-zinc-400">{c.sub}</div>
          <div className="text-[11px] text-zinc-600 truncate">{c.row?.provider ?? ""}</div>
        </div>
      ))}
    </div>
  );
}
