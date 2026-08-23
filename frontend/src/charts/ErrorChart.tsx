import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

export default function ErrorChart({ series }: { series: Array<{ hour: string; TIMEOUT: number; RATE_LIMITED: number; PROVIDER_ERROR: number; MODEL_UNAVAILABLE: number; STREAM_ERROR: number }> }) {
  if (series.length === 0) return <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center text-zinc-500">Error breakdown appears after benchmarks run (grouped: timeout, rate limit, 5xx, 4xx/model unavailable, stream).</div>;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold mb-2">Errors over time (stacked by error_type)</div>
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="hour" tick={{ fontSize: 11, fill: "#a1a1aa" }} />
            <YAxis tick={{ fontSize: 11, fill: "#a1a1aa" }} />
            <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46" }} />
            <Legend />
            <Bar dataKey="TIMEOUT" stackId="e" fill="#f59e0b" />
            <Bar dataKey="RATE_LIMITED" stackId="e" fill="#eab308" />
            <Bar dataKey="PROVIDER_ERROR" stackId="e" fill="#ef4444" />
            <Bar dataKey="MODEL_UNAVAILABLE" stackId="e" fill="#a1a1aa" />
            <Bar dataKey="STREAM_ERROR" stackId="e" fill="#8b5cf6" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
