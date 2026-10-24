import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

const COLORS = [
  "#a78bfa",
  "#22d3ee",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#60a5fa",
];

type Metric = "both" | "e2e" | "decode";
type SeriesPoint = {
  hour_start: string;
  median_tps: number | null;
  median_e2e_tps: number | null;
};
type Series = { id: number; label: string; points: SeriesPoint[] };

/** Stable row/legend key; also keeps the two metrics visibly separate. */
function metricKey(label: string, metric: "e2e" | "decode"): string {
  return `${label} · ${metric === "e2e" ? "End-to-end" : "Decode"}`;
}

export default function TpsChart({
  series,
  range,
}: {
  series: Series[];
  range: string;
}) {
  const isTenMin = range === "1h";
  // ponytail: auto-log when an outlier (e.g. diffusion 11k vs LLM ~500) would flatten everything; toggle overrides
  const [logOverride, setLogOverride] = useState<boolean | null>(null);
  // Visible metric: both for a single model, end-to-end for multi-model
  // comparison (the ranked metric) until the user overrides it.
  const [metricOverride, setMetricOverride] = useState<Metric | null>(null);
  const metric: Metric = metricOverride ?? (series.length === 1 ? "both" : "e2e");
  // Auto-log considers both value sets so switching metric never re-flattens
  // the scale unexpectedly.
  const allVals = series
    .flatMap((s) =>
      s.points.flatMap((p) => [p.median_e2e_tps ?? 0, p.median_tps ?? 0]),
    )
    .filter((v) => v > 0);
  const autoLog =
    allVals.length > 0 && Math.max(...allVals) / Math.min(...allVals) > 10;
  const log = logOverride ?? autoLog;
  // normalize to time-indexed rows — 10m buckets for 1h range, hourly otherwise
  const allTimes = Array.from(
    new Set(series.flatMap((s) => s.points.map((p) => p.hour_start))),
  ).sort();
  const rows = allTimes.map((t) => {
    const d = new Date(t);
    const label = isTenMin
      ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString(undefined, {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
        });
    const row: Record<string, unknown> = { time: label };
    for (const s of series) {
      const pt = s.points.find((p) => p.hour_start === t);
      row[metricKey(s.label, "e2e")] = pt?.median_e2e_tps ?? null;
      row[metricKey(s.label, "decode")] = pt?.median_tps ?? null;
    }
    row._raw = t;
    return row;
  });
  const visible: Array<"e2e" | "decode"> =
    metric === "both" ? ["e2e", "decode"] : [metric];
  const hasE2e = series.some((s) =>
    s.points.some((p) => p.median_e2e_tps != null),
  );

  if (series.length === 0)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-500">
        Select models from leaderboard to compare TPS (
        {isTenMin ? "10m buckets" : "hourly aggregates"}). Range: {range}.
      </div>
    );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold mb-2 flex flex-wrap items-center justify-between gap-2">
        <span>
          {isTenMin
            ? "1-hour TPS (median per 10m)"
            : "7-day TPS (median per hour)"}{" "}
          —{" "}
          {metric === "both"
            ? "End-to-end vs Decode"
            : metric === "e2e"
              ? "End-to-end"
              : "Decode"}
        </span>
        <span className="text-[11px] text-zinc-500 flex items-center gap-2">
          <span
            role="group"
            aria-label="TPS metric"
            className="inline-flex rounded border border-zinc-700 overflow-hidden"
          >
            {(["both", "e2e", "decode"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetricOverride(m)}
                aria-pressed={metric === m}
                title={
                  m === "both"
                    ? "Both — end-to-end solid, decode dashed"
                    : m === "e2e"
                      ? "End-to-end TPS (includes TTFT) — ranked"
                      : "Decode TPS (excludes TTFT) — diagnostic only"
                }
                className={`px-1.5 py-0.5 transition-colors ${metric === m ? "bg-zinc-700 text-zinc-100" : "hover:text-zinc-300"}`}
              >
                {m === "both" ? "Both" : m === "e2e" ? "End-to-end" : "Decode"}
              </button>
            ))}
          </span>
          <button
            onClick={() => setLogOverride((v) => !(v ?? autoLog))}
            className="px-1.5 py-0.5 rounded border border-zinc-700 hover:border-zinc-500 hover:text-zinc-300"
            title={
              log
                ? "Switch to linear scale"
                : "Switch to log scale (outlier flattens the rest)"
            }
          >
            {log ? "log" : "linear"}
          </button>
          {isTenMin
            ? "10m buckets • 6 points per hour"
            : "hourly aggregates • not provider-reported"}
        </span>
      </div>
      {!hasE2e && metric !== "decode" && (
        <div className="mb-2 text-[11px] text-amber-400/90">
          No end-to-end samples in this window yet — decode lines are shown
          below; history fills in as runs are re-aggregated.
        </div>
      )}
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid stroke="#71717a" strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 11, fill: "#71717a" }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#71717a" }}
              scale={log ? "log" : "linear"}
              domain={log ? ["auto", "auto"] : [0, "auto"]}
              label={{
                value: "TPS",
                angle: -90,
                position: "insideLeft",
                fill: "#71717a",
              }}
            />
            <Tooltip
              contentStyle={{
                background: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: 10,
              }}
              labelStyle={{ color: "#e4e4e7" }}
            />
            <Legend />
            {series.flatMap((s, i) =>
              visible.map((m) => {
                const key = metricKey(s.label, m);
                return (
                  <Line
                    key={`${s.id}-${m}`}
                    type="monotone"
                    dataKey={(row: Record<string, unknown>) => row[key] ?? null}
                    name={key}
                    stroke={COLORS[i % COLORS.length]!}
                    strokeDasharray={m === "decode" ? "4 4" : undefined}
                    strokeOpacity={m === "decode" ? 0.55 : 1}
                    dot={false}
                    strokeWidth={2}
                    connectNulls
                  />
                );
              }),
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
