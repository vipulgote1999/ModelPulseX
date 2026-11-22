export default function RecommendationCards({
  rows,
}: {
  rows: Array<{
    display_name: string;
    model: string;
    provider: string;
    active?: boolean;
    free_status?: string;
    tps_now: number | null;
    tps_7d?: number | null;
    /** End-to-end latest run, with 7d fallback used for selection. */
    e2e_tps_now: number | null;
    e2e_tps_7d: number | null;
    ttft_now: number | null;
    ttft_7d?: number | null;
    uptime_7d: number | null;
    overall_score: number | null;
  }>;
}) {
  if (rows.length === 0) return null;
  // Match the backend recommendation policy: only currently-usable FREE rows.
  // An inactive PREVIOUSLY_FREE model keeps a frozen 7d uptime/speed and must
  // never be crowned as the model to use now.
  const eligible = rows.filter(
    (r) => r.active !== false && (r.free_status == null || r.free_status === "FREE"),
  );
  if (eligible.length === 0) return null;
  const sorted = [...eligible]
    .filter((r) => r.overall_score != null)
    .sort((a, b) => (b.overall_score ?? -1) - (a.overall_score ?? -1));
  const best = sorted[0];
  // Fastest follows end-to-end throughput (the ranked metric), never decode.
  const e2eOf = (r: (typeof rows)[number]) => r.e2e_tps_now ?? r.e2e_tps_7d;
  const fastest = [...eligible]
    .filter((r) => e2eOf(r) != null)
    .sort((a, b) => (e2eOf(b) ?? -1) - (e2eOf(a) ?? -1))[0];
  const ttftOf = (r: (typeof rows)[number]) => r.ttft_now ?? r.ttft_7d ?? null;
  const lowest = [...eligible]
    .filter((r) => ttftOf(r) != null)
    .sort((a, b) => (ttftOf(a) ?? Infinity) - (ttftOf(b) ?? Infinity))[0];
  const reliable = [...eligible]
    .filter((r) => r.uptime_7d != null)
    .sort((a, b) => (b.uptime_7d ?? -1) - (a.uptime_7d ?? -1))[0];
  const cards = [
    {
      icon: "🏆",
      label: "BEST OVERALL",
      row: best,
      sub: best ? `score ${best.overall_score}` : "—",
    },
    {
      icon: "⚡",
      label: "Fastest now (end-to-end)",
      row: fastest,
      sub: fastest
        ? `${(fastest.e2e_tps_now ?? fastest.e2e_tps_7d ?? 0).toFixed(1)} E2E TPS${fastest.e2e_tps_now == null ? " ·7d" : ""} · decode ${(fastest.tps_now ?? fastest.tps_7d) != null ? (fastest.tps_now ?? fastest.tps_7d)!.toFixed(1) : "—"}`
        : "—",
    },
    {
      icon: "🚀",
      label: "LOWEST TTFT",
      row: lowest,
      sub: lowest && ttftOf(lowest) != null ? `${Math.round(ttftOf(lowest)!)}ms` : "—",
    },
    {
      icon: "🛡",
      label: "MOST RELIABLE",
      row: reliable,
      sub:
        reliable?.uptime_7d != null
          ? `${(reliable.uptime_7d * 100).toFixed(1)}% 7d`
          : "—",
    },
  ]; // ponytail: dropped BEST CODING (was rows[0] mislabeled, no per-benchmark data) + CONSISTENCY (dup of MOST RELIABLE)
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-4 gap-3"
      data-testid="recommendation-cards"
    >
      {cards.map((c) => (
        <div
          key={c.label}
          data-testid="recommendation-card"
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
        >
          <div className="text-[11px] tracking-widest text-zinc-500">
            {c.icon} {c.label}
          </div>
          <div
            className="mt-1 font-semibold text-sm leading-tight truncate"
            title={c.row?.display_name ?? ""}
          >
            {c.row?.display_name ?? "—"}
          </div>
          <div className="text-[11px] text-zinc-500 mono truncate">
            {c.row?.model ?? ""}
          </div>
          <div className="text-xs mt-1 text-zinc-400">{c.sub}</div>
          <div className="text-[11px] text-zinc-600 truncate">
            {c.row?.provider ?? ""}
          </div>
        </div>
      ))}
    </div>
  );
}
