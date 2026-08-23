import { useEffect, useState } from "react";

export default function ComparePanel({ selected }: { selected: number[] }) {
  const [data, setData] = useState<{ compare: Array<{ display_name: string; provider: string; tps_24h: number | null; tps_7d: number | null; ttft_24h: number | null; ttft_7d: number | null; uptime_7d: number | null; error_rate: number | null }>; recommended_provider: string | null } | null>(null);
  useEffect(() => {
    if (selected.length === 0) { setData(null); return; }
    fetch(`/api/compare?models=${selected.join(",")}`).then((r) => r.json()).then((j) => setData(j as unknown as typeof data)).catch(() => setData(null));
  }, [selected.join(",")]);
  if (!selected.length) return <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">Select 2–4 models from the leaderboard to compare. When the same underlying model exists on both providers (e.g., laguna family) you will see a per-provider table with the winner highlighted.</div>;
  if (!data) return <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">Loading comparison…</div>;
  const rows = data.compare;
  const best = (k: "tps_7d" | "tps_24h") => rows.reduce((b, r) => (r[k] ?? -1) > (b?.[k] ?? -1) ? r : b, rows[0] as typeof rows[number]);
  const bestTtft = (k: "ttft_7d" | "ttft_24h") => rows.reduce((b, r) => (r[k] != null && (b?.[k] == null || r[k]! < b[k]!)) ? r : b, rows[0] as typeof rows[number]);
  const winner = (v: string) => data.recommended_provider === v;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold flex items-center justify-between">Same-model provider comparison <span className="text-xs font-normal text-zinc-400">Recommended provider: <b className="text-white">{data.recommended_provider ?? "—"}</b> (by 7d TPS)</span></div>
      <div className="mt-3 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] tracking-widest text-zinc-500 border-b border-zinc-800"><tr><th className="text-left px-3 py-2">Provider / Model</th><th className="text-right px-2 py-2">TPS 24h</th><th className="text-right px-2 py-2">TPS 7d</th><th className="text-right px-2 py-2">TTFT 24h</th><th className="text-right px-2 py-2">TTFT 7d</th><th className="text-right px-2 py-2">Uptime 7d</th><th className="text-right px-2 py-2">Err%</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.display_name + r.provider} className="border-b border-zinc-800/60">
                <td className="px-3 py-2 font-medium">{r.display_name} <span className={`ml-2 text-[11px] px-2 py-0.5 rounded-full border ${winner(r.provider) ? "border-emerald-700 bg-emerald-900/40 text-emerald-300" : "border-zinc-700 text-zinc-400"}`}>{r.provider}{winner(r.provider) ? " ★" : ""}</span></td>
                <td className={`px-2 py-2 text-right mono ${best("tps_24h")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}>{r.tps_24h?.toFixed(1) ?? "—"}</td>
                <td className={`px-2 py-2 text-right mono ${best("tps_7d")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}>{r.tps_7d?.toFixed(1) ?? "—"}</td>
                <td className={`px-2 py-2 text-right mono ${bestTtft("ttft_24h")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}>{r.ttft_24h != null ? `${Math.round(r.ttft_24h)}ms` : "—"}</td>
                <td className={`px-2 py-2 text-right mono ${bestTtft("ttft_7d")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}>{r.ttft_7d != null ? `${Math.round(r.ttft_7d)}ms` : "—"}</td>
                <td className="px-2 py-2 text-right mono">{r.uptime_7d != null ? `${(r.uptime_7d * 100).toFixed(1)}%` : "—"}</td>
                <td className="px-2 py-2 text-right mono">{r.error_rate != null ? `${(r.error_rate * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">Calculated from actual benchmark data (hourly aggregates + raw). Higher TPS / lower TTFT highlighted. If a model is Previously Free, last 7d aggregates are frozen at last hour.</div>
    </div>
  );
}
