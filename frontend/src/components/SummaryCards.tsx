import { fmtMs, fmtTps } from "../lib/utils";

type Props = {
  summary?: {
    free_models: number;
    online_now: number;
    /** Legacy alias of the end-to-end leader; kept so old payloads type-check. */
    best_tps: {
      display_name?: string;
      model?: string;
      tps_now?: number | null;
      tps_7d?: number | null;
    } | null;
    /** End-to-end leader — the only ranked throughput metric. */
    best_e2e_tps: {
      display_name?: string;
      model?: string;
      e2e_tps_now?: number | null;
      e2e_tps_7d?: number | null;
      tps_now?: number | null;
      tps_7d?: number | null;
    } | null;
    best_ttft: {
      display_name?: string;
      ttft_now?: number | null;
      ttft_7d?: number | null;
    } | null;
    benchmarks_24h: number;
  };
  meta?: {
    is_stale: boolean;
    live: string | null;
    stale_message: string | null;
  };
  leaderboard?: Array<{
    display_name?: string;
    uptime_7d: number | null;
    overall_score: number | null;
  }>;
};

export default function SummaryCards({ summary, meta, leaderboard }: Props) {
  // Most reliable model in one pass (also names it, like the TPS/TTFT cards do).
  let mostReliable: { display_name?: string; uptime_7d: number | null } | null =
    null;
  for (const r of leaderboard ?? []) {
    if (
      r.uptime_7d != null &&
      (mostReliable == null || r.uptime_7d > (mostReliable.uptime_7d ?? 0))
    )
      mostReliable = r;
  }
  // Latest measured run, else the 7d median. The `·7d` marker makes the
  // fallback explicit; a missing decode value stays "—" rather than reusing
  // the end-to-end number.
  const e2eBest = summary?.best_e2e_tps;
  const e2eValue = e2eBest?.e2e_tps_now ?? e2eBest?.e2e_tps_7d ?? null;
  const e2eIs7d = e2eBest?.e2e_tps_now == null && e2eBest?.e2e_tps_7d != null;
  const cards: Array<{
    label: string;
    value: string | number;
    hint: string;
    sub?: string;
  }> = [
    {
      label: "FREE MODELS",
      value: summary?.free_models ?? "—",
      hint: "discovered",
    },
    {
      label: "ONLINE NOW",
      value: summary?.online_now ?? "—",
      hint: "last 10m",
    },
    {
      label: "BEST END-TO-END TPS",
      value: fmtTps(e2eValue),
      hint:
        (e2eBest?.display_name ?? e2eBest?.model ?? "") +
        (e2eIs7d ? " ·7d" : ""),
      sub: `decode ${fmtTps(e2eBest?.tps_now ?? null)}`,
    },
    {
      label: "BEST TTFT",
      value: fmtMs(
        summary?.best_ttft?.ttft_now ?? summary?.best_ttft?.ttft_7d ?? null,
      ),
      hint: summary?.best_ttft?.display_name ?? "",
    },
    {
      label: "BEST RELIABILITY",
      value:
        mostReliable?.uptime_7d != null
          ? `${(mostReliable.uptime_7d * 100).toFixed(1)}%`
          : "—",
      hint: mostReliable?.display_name ?? "7d uptime",
    },
    {
      label: "BENCHMARKS / 24H",
      value: summary?.benchmarks_24h ?? "—",
      hint: meta?.is_stale
        ? (meta.stale_message ?? "STALE")
        : (meta?.live ?? "● LIVE"),
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
        >
          <div className="text-[11px] tracking-widest text-zinc-500 font-semibold">
            {c.label}
          </div>
          <div className="text-xl font-semibold mt-1 mono">
            {String(c.value)}
          </div>
          <div className="text-[11px] text-zinc-500 truncate">
            {c.hint || "\u00A0"}
          </div>
          {c.sub && (
            <div className="text-[10px] text-zinc-600 truncate">{c.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
}
