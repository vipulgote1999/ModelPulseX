import { useEffect, useMemo, useState } from "react";
import { formatHash } from "../lib/router";

type ModelEntry = {
  id: number;
  provider_name: string;
  provider_model_id: string;
  display_name: string;
  free_status: string;
  active: number;
  benchmark_enabled?: number | null;
  context_length: number | null;
  input_price: string | null;
  output_price: string | null;
};

function price(v: string | null): string {
  if (v == null || v === "") return "—";
  return v === "0" ? "free" : v;
}

function statusChip(s: string): string {
  if (s === "FREE") return "border-emerald-800 bg-emerald-900/30 text-emerald-300";
  if (s === "PREVIOUSLY_FREE") return "border-amber-800 bg-amber-900/30 text-amber-300";
  if (s === "PAID") return "border-rose-800 bg-rose-900/30 text-rose-300";
  return "border-zinc-700 bg-zinc-800/60 text-zinc-400";
}

export default function Models() {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    setFailed(false);
    fetch("/api/models", { signal: ctl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j: unknown) => {
        if (!ctl.signal.aborted)
          setModels(((j as { models?: ModelEntry[] }).models ?? []) as ModelEntry[]);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setFailed(true);
      });
    return () => ctl.abort();
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, ModelEntry[]>();
    for (const mod of models ?? []) {
      const arr = m.get(mod.provider_name) ?? [];
      arr.push(mod);
      m.set(mod.provider_name, arr);
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, list]) => ({
        provider: p,
        list: [...list].sort((x, y) => x.display_name.localeCompare(y.display_name)),
      }));
  }, [models]);

  if (failed)
    return (
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-10 text-sm text-zinc-500">
        Could not load the model catalog. Try reloading.
      </div>
    );
  if (models == null)
    return (
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-10 text-zinc-400 animate-pulse">
        Loading model catalog…
      </div>
    );

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Models</h1>
        <p className="text-sm text-zinc-400 mt-1">
          {models.length} models across {groups.length} providers. Paid and unknown rows stay listed
          for catalog visibility but are never auto-benchmarked. Select a model for its detail page.
        </p>
      </div>
      {groups.map((g) => (
        <section key={g.provider} className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
          <header className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
            <span className="font-semibold text-zinc-100">{g.provider}</span>
            <span className="text-xs text-zinc-500">{g.list.length} models</span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] tracking-widest text-zinc-500 border-b border-zinc-800">
                <tr>
                  <th className="text-left px-4 py-2">Model</th>
                  <th className="text-left px-2 py-2 hidden md:table-cell">Model id</th>
                  <th className="text-left px-2 py-2">Status</th>
                  <th className="text-right px-2 py-2 hidden lg:table-cell">In price</th>
                  <th className="text-right px-2 py-2 hidden lg:table-cell">Out price</th>
                  <th className="text-right px-4 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {g.list.map((m) => (
                  <tr key={m.id} className="border-b border-zinc-800/60 hover:bg-zinc-800/40">
                    <td className="px-4 py-2 font-medium text-zinc-100">{m.display_name}</td>
                    <td className="px-2 py-2 mono text-[11px] text-zinc-500 hidden md:table-cell">{m.provider_model_id}</td>
                    <td className="px-2 py-2">
                      <span className={"text-[11px] px-2 py-0.5 rounded-full border " + statusChip(m.free_status)}>
                        {m.free_status}
                      </span>
                      {m.active !== 1 && (
                        <span className="ml-2 text-[11px] text-zinc-500">inactive</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right mono text-zinc-400 hidden lg:table-cell">{price(m.input_price)}</td>
                    <td className="px-2 py-2 text-right mono text-zinc-400 hidden lg:table-cell">{price(m.output_price)}</td>
                    <td className="px-4 py-2 text-right">
                      <a href={formatHash({ page: "model", modelId: m.id, compare: [] })} className="text-xs text-cyan-300 hover:text-cyan-100">
                        Open →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
