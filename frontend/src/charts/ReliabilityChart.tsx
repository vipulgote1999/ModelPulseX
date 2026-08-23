export default function ReliabilityChart({ models }: { models: Array<{ display_name: string; provider: string; points: Array<{ hour_start: string; success_rate: number | null }> }> }) {
  if (models.length === 0) return <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center text-zinc-500">Select models to see 7-day availability timeline (█ online ░ unavailable).</div>;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold mb-2">Reliability — 7-day availability timeline</div>
      <div className="space-y-3">
        {models.map((m) => (
          <div key={m.display_name} className="flex items-center gap-3">
            <div className="w-[220px] truncate text-xs font-medium text-zinc-300">{m.display_name} <span className="text-[11px] text-zinc-500">{m.provider}</span></div>
            <div className="flex-1 flex gap-[1px] h-6 rounded overflow-hidden border border-zinc-800 bg-zinc-900">
              {m.points.length === 0 && <span className="text-[11px] text-zinc-500 px-2 self-center">no hourly samples yet — check raw history</span>}
              {m.points.map((p) => {
                const ok = (p.success_rate ?? 0) >= 0.5;
                return <div key={p.hour_start} title={`${new Date(p.hour_start).toLocaleString()} — success ${(p.success_rate ?? 0) * 100 | 0}%`} className={`flex-1 ${ok ? "bg-emerald-500/80" : "bg-zinc-700"}`} />;
              })}
            </div>
            <div className="w-[160px] text-[11px] text-zinc-400">
              {(() => {
                const succ = m.points.filter((p) => (p.success_rate ?? 0) >= 1).length;
                const tot = m.points.length || 1;
                const up = Math.round((succ / tot) * 100);
                return `${up}% hours fully up`;
              })()}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">█ = hour fully successful (≥50% success) ░ = degraded/unavailable. Data from hourly aggregates (30–90d) + raw fallback.</div>
    </div>
  );
}
