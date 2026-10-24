import { useEffect, useState, lazy, Suspense } from "react";
import { formatHash } from "../lib/router";
import { getAAMeta } from "../lib/intelligence";
import { useHistory } from "../hooks/useHistory";

const TpsChart = lazy(() => import("../charts/TpsChart"));
const TtftChart = lazy(() => import("../charts/TtftChart"));
const ReliabilityChart = lazy(() => import("../charts/ReliabilityChart"));

type ModelRecord = {
  id: number;
  provider_name: string;
  provider_model_id: string;
  display_name: string;
  free_status: string;
  active: number;
  context_length: number | null;
  input_price: string | null;
  output_price: string | null;
};

type CompareRow = {
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
};

function fmtTps(v: number | null): string {
  return v == null ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

function fmtMs(v: number | null): string {
  if (v == null) return "—";
  return v >= 1000 ? (v / 1000).toFixed(1) + "s" : Math.round(v) + "ms";
}

export default function ModelDetail({ modelId }: { modelId: number }) {
  const [model, setModel] = useState<ModelRecord | null>(null);
  const [summary, setSummary] = useState<CompareRow | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    setMissing(false);
    setModel(null);
    setSummary(null);
    fetch("/api/models/" + modelId, { signal: ctl.signal })
      .then((r) => {
        if (r.status === 404) {
          if (!ctl.signal.aborted) setMissing(true);
          return null;
        }
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j: unknown) => {
        if (j != null && !ctl.signal.aborted)
          setModel((j as { model?: ModelRecord }).model as ModelRecord);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setMissing(true);
      });
    fetch("/api/compare?models=" + modelId, { signal: ctl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j: unknown) => {
        if (!ctl.signal.aborted) {
          const rows = (j as { compare?: CompareRow[] }).compare ?? [];
          setSummary(rows[0] ?? null);
        }
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [modelId]);

  const { data: history } = useHistory(modelId > 0 ? [modelId] : [], "7d", "all");
  const points = history[modelId] ?? [];
  const label = model != null ? model.display_name : "model " + modelId;
  const provider = model?.provider_name ?? "";
  const meta = model != null ? getAAMeta(model.provider_model_id) : null;

  if (missing)
    return (
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-10">
        <h1 className="text-xl font-bold text-white">Model not found</h1>
        <p className="text-sm text-zinc-400 mt-2">
          No publicly listed model has this id. It may never have existed, or it may
          be inactive, paid, or admin-disabled.
        </p>
        <a href={formatHash({ page: "models", modelId: null, compare: [] })} className="text-sm text-cyan-300 hover:text-cyan-100 mt-4 inline-block">
          Back to all models →
        </a>
      </div>
    );
  if (model == null)
    return (
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-10 text-zinc-400 animate-pulse">
        Loading model…
      </div>
    );

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <a href={formatHash({ page: "models", modelId: null, compare: [] })} className="text-xs text-zinc-500 hover:text-zinc-300">
          ← All models
        </a>
        <h1 className="text-2xl font-bold text-white mt-1">{model.display_name}</h1>
        <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
          <span className="px-2 py-0.5 rounded-full border border-cyan-800 bg-cyan-900/30 text-cyan-300">{model.provider_name}</span>
          <span className="px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400">{model.free_status}</span>
          {meta?.thinking === true && (
            <span className="px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800">Thinking</span>
          )}
          {meta?.reasoningModel === false && (
            <span className="text-zinc-500">non-reasoning</span>
          )}
          {meta?.url != null && meta.score != null && (
            <a href={meta.url} target="_blank" rel="noreferrer" className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-white" title="Artificial Analysis Intelligence Index">
              Intelligence {meta.score.toFixed(1)} ↗
            </a>
          )}
        </div>
        <p className="text-[11px] text-zinc-500 mono mt-2">{model.provider_model_id}</p>
      </div>

      {summary != null && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="rounded-xl border border-emerald-800/70 bg-emerald-950/20 p-3">
            <div className="text-[10px] tracking-wide text-emerald-300/80">
              End-to-end TPS (includes TTFT)
            </div>
            <div className="text-xl font-semibold text-zinc-100 mono">
              24h {fmtTps(summary.e2e_tps_24h)}
            </div>
            <div className="text-xs text-zinc-400 mono">
              7d {fmtTps(summary.e2e_tps_7d)}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
            <div className="text-[10px] tracking-wide text-zinc-500">
              Decode TPS (excludes TTFT)
            </div>
            <div className="text-xl font-semibold text-zinc-300 mono">
              24h {fmtTps(summary.tps_24h)}
            </div>
            <div className="text-xs text-zinc-400 mono">
              7d {fmtTps(summary.tps_7d)}
            </div>
            {summary.median_chunks_7d != null &&
              summary.median_chunks_7d < 8 && (
                <span
                  className="mt-1 inline-flex text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800"
                  title="Tokens arrive in large blocks, so Decode TPS measures block throughput, not per-token speed. Use End-to-end TPS to compare."
                >
                  Block delivery
                </span>
              )}
          </div>
          {(
            [
              ["TTFT", fmtMs(summary.ttft_24h ?? summary.ttft_7d)],
              [
                "Uptime 7d",
                summary.uptime_7d != null
                  ? (summary.uptime_7d * 100).toFixed(1) + "%"
                  : "—",
              ],
              [
                "Error",
                summary.error_rate != null
                  ? (summary.error_rate * 100).toFixed(1) + "%"
                  : "—",
              ],
            ] as Array<[string, string]>
          ).map(([k, v]) => (
            <div key={k} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
              <div className="text-[11px] tracking-widest text-zinc-500">{k}</div>
              <div className="text-xl font-semibold text-zinc-100 mono">{v}</div>
            </div>
          ))}
        </div>
      )}

      <Suspense fallback={<div className="rounded-xl border border-zinc-800 p-8 text-center text-zinc-500 animate-pulse">Loading charts…</div>}>
        <TpsChart
          range="7d"
          series={[{ id: model.id, label, points: points.map((p) => ({ hour_start: p.hour_start, median_tps: p.median_tps, median_e2e_tps: p.median_e2e_tps })) }]}
        />
        <TtftChart
          range="7d"
          series={[{ id: model.id, label, points: points.map((p) => ({ hour_start: p.hour_start, median_ttft: p.median_ttft })) }]}
        />
        <ReliabilityChart
          models={[{ display_name: model.display_name, provider, points: points.map((p) => ({ hour_start: p.hour_start, success_rate: p.success_rate })) }]}
        />
      </Suspense>
      <p className="text-xs text-zinc-500">
        7-day window, hourly medians. See the methodology page for how TPS, TTFT and reliability are measured.
      </p>
    </div>
  );
}
