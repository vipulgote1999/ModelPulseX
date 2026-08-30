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
  "#8b5cf6",
  "#06b6d4",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#e879f9",
];

export default function TpsChart({
  series,
  range,
}: {
  series: Array<{
    id: number;
    label: string;
    points: Array<{ hour_start: string; median_tps: number | null }>;
  }>;
  range: string;
}) {
  const isTenMin = range === "1h";
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
      (row as Record<string, unknown>)[s.label] = pt?.median_tps ?? null;
    }
    row._raw = t;
    return row;
  });

  if (series.length === 0)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-500">
        Select models from leaderboard to compare TPS (
        {isTenMin ? "10m buckets" : "hourly aggregates"}). Range: {range}.
      </div>
    );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold mb-2 flex items-center justify-between">
        <span>
          {isTenMin
            ? "1-hour TPS (median per 10m) — Measured TPS"
            : "7-day TPS (median per hour) — Measured TPS"}
        </span>
        <span className="text-[11px] text-zinc-500">
          {isTenMin
            ? "10m buckets • 6 points per hour"
            : "hourly aggregates • not provider-reported"}
        </span>
      </div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 11, fill: "#a1a1aa" }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#a1a1aa" }}
              label={{
                value: "TPS",
                angle: -90,
                position: "insideLeft",
                fill: "#a1a1aa",
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
            {series.map((s, i) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.label}
                stroke={COLORS[i % COLORS.length]!}
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
