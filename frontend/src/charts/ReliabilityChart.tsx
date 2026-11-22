import { HOUR_UP_THRESHOLD, hoursUpPercent } from "../lib/reliability";
import { rangeLabel } from "../lib/rangeLabel";

export default function ReliabilityChart({
  models,
  range,
}: {
  models: Array<{
    display_name: string;
    provider: string;
    points: Array<{ hour_start: string; success_rate: number | null }>;
  }>;
  range?: string;
}) {
  if (models.length === 0)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center text-zinc-500">
        Select models to see the availability timeline (█ online ░ unavailable).
      </div>
    );
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold mb-2">
        Reliability — {rangeLabel(range)} availability timeline
      </div>
      <div className="space-y-3">
        {models.map((m) => {
          const pct = hoursUpPercent(m.points);
          return (
            <div
              key={`${m.display_name}\u0000${m.provider}`}
              className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
            >
              <div className="flex items-center justify-between gap-2 sm:block sm:w-[220px] truncate text-xs font-medium text-zinc-300">
                <span className="truncate">
                  {m.display_name}{" "}
                  <span className="text-[11px] text-zinc-500">{m.provider}</span>
                </span>
                <span className="shrink-0 text-[11px] text-zinc-400 sm:hidden">
                  {pct == null ? "no samples" : `${pct}% ${range === "1h" ? "10m buckets" : "hours"} up`}
                </span>
              </div>
              <div data-testid="reliability-bars" className="w-full sm:flex-1 min-w-0 flex gap-[1px] h-4 sm:h-6 rounded overflow-hidden border border-zinc-800 bg-zinc-900">
                {m.points.length === 0 && (
                  <span className="text-[11px] text-zinc-500 px-2 self-center">
                    no hourly samples yet — check raw history
                  </span>
                )}
                {m.points.map((p) => {
                  const ok =
                    (p.success_rate ?? 0) >= HOUR_UP_THRESHOLD;
                  return (
                    <div
                      key={p.hour_start}
                      title={`${new Date(p.hour_start).toLocaleString()} — success ${((p.success_rate ?? 0) * 100) | 0}%`}
                      className={`flex-1 ${ok ? "bg-emerald-400/80" : "bg-zinc-600"}`}
                    />
                  );
                })}
              </div>
              <div className="hidden sm:block w-[160px] text-[11px] text-zinc-400">
                {pct == null
                  ? "no samples"
                  : `${pct}% ${range === "1h" ? "10m buckets" : "hours"} up`}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">
        █ = {range === "1h" ? "10m bucket" : "hour"} up (≥50% success) ░ =
        degraded/unavailable. Data from hourly aggregates (30–90d) + raw
        fallback.
      </div>
    </div>
  );
}
