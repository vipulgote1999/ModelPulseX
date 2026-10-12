import { useEffect, useMemo, useState } from "react";
import { providerMeta } from "../lib/providerMeta";

type ProviderEntry = {
  name: string;
  freeTier?: { rpm?: number; rpd?: number; tokensPerDay?: number; notes?: string } | null;
};

type ModelEntry = {
  id: number;
  provider_name: string;
  display_name: string;
  provider_model_id: string;
  free_status: string;
  input_price: string | null;
  output_price: string | null;
};

function price(v: string | null): string {
  if (v == null || v === "") return "—";
  return v === "0" ? "free" : v;
}

export default function Pricing() {
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null);
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([
      fetch("/api/providers", { signal: ctl.signal }).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }),
      fetch("/api/models", { signal: ctl.signal }).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }),
    ])
      .then((ps: unknown[]) => {
        if (ctl.signal.aborted) return;
        const body = ps[0] as { providers?: ProviderEntry[]; registry?: ProviderEntry[] };
        const prov = body.registry ?? body.providers ?? [];
        const mods = (ps[1] as { models?: ModelEntry[] }).models ?? [];
        setProviders(prov as ProviderEntry[]);
        setModels(mods as ModelEntry[]);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setFailed(true);
      });
    return () => ctl.abort();
  }, []);

  const byProvider = useMemo(() => {
    const m = new Map<string, ModelEntry[]>();
    for (const mod of models ?? []) {
      const arr = m.get(mod.provider_name) ?? [];
      arr.push(mod);
      m.set(mod.provider_name, arr);
    }
    return m;
  }, [models]);

  if (failed)
    return (
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-10 text-sm text-zinc-500">
        Could not load pricing data. Try reloading.
      </div>
    );
  if (providers == null || models == null)
    return (
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-10 text-zinc-400 animate-pulse">
        Loading pricing…
      </div>
    );

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Pricing</h1>
        <p className="text-sm text-zinc-400 mt-1">
          What the benchmarked providers cost and how often we sample them. Per-model
          rates are as discovered from provider APIs — verify at the source before
          spending. Speed numbers live on the leaderboard; this page is only about cost.
        </p>
      </div>
      {providers.map((p) => {
        const meta = providerMeta(p.name);
        const list = (byProvider.get(p.name) ?? []).filter((m) => m.free_status === "FREE");
        return (
          <section key={p.name} className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
            <header className="px-4 py-3 border-b border-zinc-800">
              <div className="font-semibold text-zinc-100">{p.name}</div>
              <div className="text-xs text-zinc-400 mt-0.5">{meta.billing}</div>
              <div className="text-[11px] text-zinc-500 mt-1">
                Benchmark cadence {meta.cadence}
                {p.freeTier?.rpm != null && <span> · {p.freeTier.rpm} rpm</span>}
                {p.freeTier?.rpd != null && <span> · {p.freeTier.rpd} req/day</span>}
                {p.freeTier?.tokensPerDay != null && <span> · {p.freeTier.tokensPerDay.toLocaleString()} tok/day</span>}
                {p.freeTier?.notes != null && p.freeTier.notes !== "" && <span> · {p.freeTier.notes}</span>}
              </div>
            </header>
            {list.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] tracking-widest text-zinc-500 border-b border-zinc-800">
                    <tr>
                      <th className="text-left px-4 py-2">Model</th>
                      <th className="text-right px-2 py-2">Input / 1M</th>
                      <th className="text-right px-4 py-2">Output / 1M</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => (
                      <tr key={m.id} className="border-b border-zinc-800/60">
                        <td className="px-4 py-2 text-zinc-100">
                          {m.display_name}
                          <span className="ml-2 text-[11px] text-zinc-500 mono">{m.provider_model_id}</span>
                        </td>
                        <td className="px-2 py-2 text-right mono text-zinc-400">{price(m.input_price)}</td>
                        <td className="px-4 py-2 text-right mono text-zinc-400">{price(m.output_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-3 text-xs text-zinc-500">No free models currently listed for this provider.</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
