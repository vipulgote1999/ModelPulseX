import { useEffect, useState } from "react";
import { fmtTps } from "../lib/utils";

export default function ComparePanel({ selected }: { selected: number[] }) {
  const [data, setData] = useState<{
    compare: Array<{
      display_name: string;
      provider: string;
      tps_24h: number | null;
      tps_7d: number | null;
      e2e_tps_24h: number | null;
      e2e_tps_7d: number | null;
      ttft_24h: number | null;
      ttft_7d: number | null;
      uptime_7d: number | null;
      error_rate: number | null;
      median_chunks_7d: number | null;
    }>;
    recommended_provider: string | null;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (selected.length === 0) {
      setData(null);
      setFailed(false);
      return;
    }
    // Abort + staleness guard: rapid pin changes must not let an older slow
    // response overwrite newer data (or crash on a 404 error body, which has
    // no .compare array).
    const ctl = new AbortController();
    setFailed(false);
    fetch(`/api/compare?models=${selected.join(",")}`, { signal: ctl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j) => {
        // SAFETY: /api/compare response shape is owned by src/api/compare.ts; narrowed to displayed fields
        if (!ctl.signal.aborted) setData(j as unknown as typeof data);
      })
      .catch(() => {
        if (!ctl.signal.aborted) {
          setData(null);
          setFailed(true);
        }
      });
    return () => ctl.abort();
  }, [selected.join(",")]);
  if (!selected.length)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
        Select 2–6 models from the leaderboard to compare. When the same
        underlying model exists on both providers (e.g., laguna family) you will
        see a per-provider table with the winner highlighted.
      </div>
    );
  if (failed)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
        Couldn&apos;t load the comparison — the selected models may no longer be
        benchmarked. Try re-selecting.
      </div>
    );
  if (!data)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-500">
        Loading comparison…
      </div>
    );
  const rows = data.compare;
  // Ranking and the best-cell highlight follow end-to-end throughput only;
  // decode stays visible but is never the comparison winner.
  const best = (k: "e2e_tps_7d" | "e2e_tps_24h") =>
    rows.reduce(
      (b, r) => ((r[k] ?? -1) > (b?.[k] ?? -1) ? r : b),
      rows[0] as (typeof rows)[number],
    );
  const bestTtft = (k: "ttft_7d" | "ttft_24h") =>
    rows.reduce(
      (b, r) => (r[k] != null && (b?.[k] == null || r[k]! < b[k]!) ? r : b),
      rows[0] as (typeof rows)[number],
    );
  const winner = (v: string) => data.recommended_provider === v;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-sm font-semibold flex items-center justify-between">
        Same-model provider comparison{" "}
        <span className="text-xs font-normal text-zinc-400">
          Recommended provider:{" "}
          <b className="text-white">{data.recommended_provider ?? "—"}</b> (by
          7d end-to-end TPS)
        </span>
      </div>
      <div className="mt-3 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] tracking-widest text-zinc-500 border-b border-zinc-800">
            <tr>
              <th rowSpan={2} className="text-left px-3 py-2 align-bottom">
                Provider / Model
              </th>
              <th
                colSpan={2}
                className="text-center px-2 pt-2 pb-1 border-b border-zinc-800/70"
              >
                Throughput 24h
              </th>
              <th
                colSpan={2}
                className="text-center px-2 pt-2 pb-1 border-b border-zinc-800/70"
              >
                Throughput 7d
              </th>
              <th
                rowSpan={2}
                className="text-right px-2 py-2 align-bottom"
              >
                TTFT 24h
              </th>
              <th
                rowSpan={2}
                className="text-right px-2 py-2 align-bottom"
              >
                TTFT 7d
              </th>
              <th
                rowSpan={2}
                className="text-right px-2 py-2 align-bottom"
              >
                Uptime 7d
              </th>
              <th
                rowSpan={2}
                className="text-right px-2 py-2 align-bottom"
              >
                Err%
              </th>
            </tr>
            <tr>
              <th className="text-right px-2 py-1 text-zinc-500">Decode</th>
              <th className="text-right px-2 py-1 text-zinc-300">End-to-end</th>
              <th className="text-right px-2 py-1 text-zinc-500">Decode</th>
              <th className="text-right px-2 py-1 text-zinc-300">End-to-end</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.display_name + r.provider}
                className="border-b border-zinc-800/60"
              >
                <td className="px-3 py-2 font-medium">
                  {r.display_name}{" "}
                  <span
                    className={`ml-2 text-[11px] px-2 py-0.5 rounded-full border ${winner(r.provider) ? "border-emerald-700 bg-emerald-900/40 text-emerald-300" : "border-zinc-700 text-zinc-400"}`}
                    title={winner(r.provider) ? "Fastest (end-to-end)" : undefined}
                  >
                    {r.provider}
                    {winner(r.provider) ? " ★" : ""}
                  </span>
                  {r.median_chunks_7d != null && r.median_chunks_7d < 8 && (
                    <div className="mt-1">
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800"
                        title="Tokens arrive in large blocks, so Decode TPS measures block throughput, not per-token speed. Use End-to-end TPS to compare."
                      >
                        Block delivery
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-2 py-2 text-right mono text-zinc-500">
                  {fmtTps(r.tps_24h)}
                </td>
                <td
                  className={`px-2 py-2 text-right mono ${best("e2e_tps_24h")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}
                >
                  {fmtTps(r.e2e_tps_24h)}
                </td>
                <td className="px-2 py-2 text-right mono text-zinc-500">
                  {fmtTps(r.tps_7d)}
                </td>
                <td
                  className={`px-2 py-2 text-right mono ${best("e2e_tps_7d")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}
                >
                  {fmtTps(r.e2e_tps_7d)}
                </td>
                <td
                  className={`px-2 py-2 text-right mono ${bestTtft("ttft_24h")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}
                >
                  {r.ttft_24h != null ? `${Math.round(r.ttft_24h)}ms` : "—"}
                </td>
                <td
                  className={`px-2 py-2 text-right mono ${bestTtft("ttft_7d")?.provider === r.provider ? "text-emerald-300 font-semibold" : ""}`}
                >
                  {r.ttft_7d != null ? `${Math.round(r.ttft_7d)}ms` : "—"}
                </td>
                <td className="px-2 py-2 text-right mono">
                  {r.uptime_7d != null
                    ? `${(r.uptime_7d * 100).toFixed(1)}%`
                    : "—"}
                </td>
                <td className="px-2 py-2 text-right mono">
                  {r.error_rate != null
                    ? `${(r.error_rate * 100).toFixed(1)}%`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">
        Calculated from actual benchmark data (snapshot medians + raw fallback).
        Higher end-to-end TPS / lower TTFT highlighted; decode shown for
        diagnosis. If a model is Previously Free, last 7d aggregates are frozen
        at last hour.
      </div>
    </div>
  );
}
