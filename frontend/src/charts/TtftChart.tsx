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
export default function TtftChart({
  series,
  range,
}: {
  series: Array<{
    id: number;
    label: string;
    points: Array<{ hour_start: string; median_ttft: number | null }>;
  }>;
  range?: string;
}) {
  const isTenMin = range === "1h";
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
      (row as Record<string, unknown>)[s.label] = pt?.median_ttft ?? null;
    }
    return row;
  });
  if (series.length === 0)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-500">
        Select models to compare TTFT (p50 per {isTenMin ? "10m" : "hour"}).
      </div>
    );
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold mb-2 flex items-center justify-between">
        <span>
          {isTenMin
            ? "1-hour TTFT (median per 10m) — lower is better"
            : "7-day TTFT (median, ms) — lower is better"}
        </span>
        <span className="text-[11px] text-zinc-500">
          {isTenMin
            ? "10m buckets • 6 points per hour"
            : "TTFT = first_token - started (never same axis as TPS)"}
        </span>
      </div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#a1a1aa" }} />
            <YAxis
              tick={{ fontSize: 11, fill: "#a1a1aa" }}
              label={{
                value: "TTFT ms",
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
