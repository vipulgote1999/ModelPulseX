import { useState } from "react";
import { fmtMs, fmtTps, timeAgo } from "../lib/utils";
import Sparkline from "./Sparkline";
import { getAA } from "../lib/intelligence";
import { useCooldowns, remainingStr } from "../hooks/useCooldowns";

type Row = {
  rank: number;
  model_id: number;
  model: string;
  display_name: string;
  provider: string;
  free_status: string;
  active: boolean;
  tps_now: number | null;
  tps_1h: number | null;
  tps_24h: number | null;
  tps_7d: number | null;
  ttft_now: number | null;
  ttft_7d: number | null;
  uptime_7d: number | null;
  error_rate_7d: number | null;
  status: string;
  last_test: string | null;
  overall_score: number | null;
  sparkline?: Array<number | null>;
  sampleCount24h?: number;
};

export default function Leaderboard({
  rows,
  onSelect,
  selected,
}: {
  rows: Row[];
  onSelect?: (ids: number[]) => void;
  selected?: number[];
}) {
  const [sortKey, setSortKey] = useState<keyof Row | "overall_score">("overall_score");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const sort = (k: keyof Row | "overall_score") => {
    if (sortKey === k) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setDir(k === "ttft_now" || k === "ttft_7d" ? "asc" : "desc"); }
  };
  const sorted = [...rows].sort((a: any, b: any) => {
    const av = (a as any)[sortKey] as number | null;
    const bv = (b as any)[sortKey] as number | null;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
  });

  const toggle = (id: number) => {
    if (!onSelect) return;
    const cur = selected ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 3);
    onSelect(next);
  };

  const { data: cd } = useCooldowns(12000);
  const modelCdMap = new Map((cd?.models ?? []).map((m) => [m.model_id, m]));
  const providerCdMap = new Map((cd?.providers ?? []).map((p) => [p.provider, p]));

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/80 text-[11px] tracking-widest text-zinc-400 border-b border-zinc-800">
            <tr>
              <th className="text-left px-3 py-2">#</th>
              <th className="text-left px-3 py-2">Model</th>
              <th className="text-left px-3 py-2 hidden md:table-cell">Provider</th>
              <th className="text-right px-2 py-2 cursor-pointer hover:text-white" onClick={() => sort("tps_now")}>TPS Now</th>
              <th className="text-right px-2 py-2 hidden lg:table-cell cursor-pointer hover:text-white" onClick={() => sort("tps_1h")}>1h</th>
              <th className="text-right px-2 py-2 hidden lg:table-cell cursor-pointer hover:text-white" onClick={() => sort("tps_24h")}>24h</th>
              <th className="text-right px-2 py-2 cursor-pointer hover:text-white" onClick={() => sort("tps_7d")}>7d</th>
              <th className="text-right px-2 py-2 cursor-pointer hover:text-white" onClick={() => sort("ttft_now")}>TTFT</th>
              <th className="text-right px-2 py-2 hidden lg:table-cell cursor-pointer hover:text-white" onClick={() => sort("uptime_7d")}>7d Up</th>
              <th className="text-right px-2 py-2 hidden lg:table-cell">Intelligence</th>
              <th className="text-left px-2 py-2 hidden lg:table-cell">Trend (24h)</th>
              <th className="text-right px-2 py-2 hidden sm:table-cell">Err%</th>
              <th className="text-left px-2 py-2">Status</th>
              <th className="text-left px-3 py-2 hidden md:table-cell">Last Test</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={12} className="px-4 py-10 text-center text-zinc-500">No free models discovered yet — discovery runs hourly + on deploy. Check <span className="text-zinc-300">/api/models</span>.</td></tr>
            )}
            {sorted.map((r) => (
              <tr key={r.model_id} onClick={() => toggle(r.model_id)} className={`border-b border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer ${selected?.includes(r.model_id) ? "bg-violet-950/30" : ""}`}>
                <td className="px-3 py-2 text-zinc-400">{r.rank}</td>
                <td className="px-3 py-2">
                  <div className="font-medium text-zinc-100 leading-tight">{r.display_name}</div>
                  <div className="text-[11px] text-zinc-500 mono truncate max-w-[220px]">{r.model}</div>
                  {!r.active && <span className="inline-flex text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800">Previously Free</span>}
                  {r.free_status !== "FREE" && r.active === false && <span className="ml-1 text-[10px] text-zinc-500">{r.free_status}</span>}
                </td>
                <td className="px-3 py-2 hidden md:table-cell">
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${r.provider === "opencode_zen" ? "border-violet-800 bg-violet-900/30 text-violet-300" : "border-sky-800 bg-sky-900/30 text-sky-300"}`}>{r.provider}</span>
                  {r.overall_score != null && <span className="ml-2 text-[11px] text-zinc-500">{r.overall_score}</span>}
                </td>
                <td className="px-2 py-2 text-right mono font-medium">{fmtTps(r.tps_now)}</td>
                <td className="px-2 py-2 text-right mono hidden lg:table-cell text-zinc-400">{fmtTps(r.tps_1h)}</td>
                <td className="px-2 py-2 text-right mono hidden lg:table-cell text-zinc-400">{fmtTps(r.tps_24h)}</td>
                <td className="px-2 py-2 text-right mono text-zinc-200">{fmtTps(r.tps_7d)}</td>
                <td className="px-2 py-2 text-right mono">{fmtMs(r.ttft_now ?? r.ttft_7d)}</td>
                <td className="px-2 py-2 text-right mono hidden lg:table-cell">{r.uptime_7d != null ? `${(r.uptime_7d * 100).toFixed(1)}%${(r as unknown as { sampleCount24h?: number }).sampleCount24h != null && (r as unknown as { sampleCount24h?: number }).sampleCount24h! < 12 ? ` n=${(r as unknown as { sampleCount24h?: number }).sampleCount24h}` : ""}` : "—"}</td>
                <td className="px-2 py-2 text-center hidden lg:table-cell">{(() => { const aa = getAA(r.model); return aa ? <a href={aa.url} target="_blank" rel="noreferrer" className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500" title="Artificial Analysis Intelligence Index">{aa.score.toFixed(1)}</a> : <span className="text-xs text-zinc-600">—</span>; })()}</td>
                <td className="px-2 py-2 hidden lg:table-cell"><Sparkline points={(r as unknown as { sparkline?: Array<number | null> }).sparkline ?? []} /></td>
                <td className="px-2 py-2 text-right mono hidden sm:table-cell text-zinc-400">{r.error_rate_7d != null ? `${(r.error_rate_7d * 100).toFixed(1)}%` : "—"}</td>
                <td className="px-2 py-2">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex gap-1 items-center">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${r.status === "SUCCESS" ? "bg-emerald-900/40 text-emerald-300 border border-emerald-800" : r.status === "RATE_LIMITED" ? "bg-amber-900/40 text-amber-300 border border-amber-800" : "bg-zinc-800 text-zinc-400 border border-zinc-700"}`}>{r.status}</span>
                      {(() => { const mc = modelCdMap.get(r.model_id); if (mc) return <span title={`${mc.reason ?? "MODEL_COOLDOWN"} until ${new Date(mc.cooldown_until).toLocaleString()}`} className="text-[10px] px-1.5 py-0.5 rounded bg-sky-900/30 text-sky-300 border border-sky-800">⏱ model {remainingStr(mc.cooldown_until)}</span>; const pc = providerCdMap.get(r.provider); if (pc) return <span title={`${pc.reason ?? "PROVIDER_COOLDOWN"} until ${new Date(pc.cooldown_until).toLocaleString()}`} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-300 border border-amber-800">⏱ provider {remainingStr(pc.cooldown_until)}</span>; return null; })()}
                    </div>
                    {(() => { const mc = modelCdMap.get(r.model_id); const pc = providerCdMap.get(r.provider); const cd2 = mc ?? pc; if (cd2) return <span className="text-[10px] text-zinc-500 max-w-[150px] truncate" title={cd2.reason ?? ""}>{mc ? "model timeout" : "provider timeout"} · {cd2.reason?.slice(0,30) ?? ""}</span>; return <span className="text-[10px] text-zinc-600">Measured TPS</span>; })()}
                  </div>
                </td>
                <td className="px-3 py-2 hidden md:table-cell text-xs text-zinc-500">{timeAgo(r.last_test)} {r.last_test ? `· ${new Date(r.last_test).toLocaleString()}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && <div className="px-3 py-2 text-[11px] text-zinc-500">Click rows to pin for graph comparison (max 3). Sorted by <b className="text-zinc-300">{String(sortKey)}</b> {dir}. Selected up to 3 drive the charts below.</div>}
    </div>
  );
}
