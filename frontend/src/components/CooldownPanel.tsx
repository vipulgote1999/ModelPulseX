import { useState } from "react";
import { useCooldowns, remainingStr } from "../hooks/useCooldowns";

function getAdminToken(): string | null {
  try {
    return localStorage.getItem("mpx_admin_token") || null;
  } catch { return null; }
}

function setAdminToken(v: string) {
  try { localStorage.setItem("mpx_admin_token", v); } catch {}
}

export default function CooldownPanel() {
  const { data, refresh } = useCooldowns(10000);
  const [busy, setBusy] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState<string>(() => getAdminToken() ?? "");
  const [showToken, setShowToken] = useState(false);

  const providers = data?.providers ?? [];
  const models = data?.models ?? [];
  const hasAny = providers.length > 0 || models.length > 0;

  const resetProvider = async (provider: string, clearAll = false) => {
    let token = getAdminToken() || tokenInput;
    if (!token) {
      const t = prompt("Admin token required to reset cooldown (ADMIN_TOKEN):");
      if (!t) return;
      token = t;
      setTokenInput(t);
      setAdminToken(t);
    }
    setBusy(`p:${provider}`);
    try {
      const r = await fetch("/api/admin/cooldown/reset", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-admin-token": token },
        body: JSON.stringify({ provider, clearAll }),
      });
      if (!r.ok) {
        const txt = await r.text();
        alert(`Reset failed ${r.status}: ${txt.slice(0,300)}`);
        if (r.status === 401) setShowToken(true);
      } else {
        await refresh();
      }
    } finally { setBusy(null); }
  };

  const resetModel = async (model_id: number) => {
    let token = getAdminToken() || tokenInput;
    if (!token) {
      const t = prompt("Admin token required to reset cooldown:");
      if (!t) return;
      token = t;
      setTokenInput(t);
      setAdminToken(t);
    }
    setBusy(`m:${model_id}`);
    try {
      const r = await fetch("/api/admin/cooldown/reset", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-admin-token": token },
        body: JSON.stringify({ model_id }),
      });
      if (!r.ok) {
        const txt = await r.text();
        alert(`Reset failed ${r.status}: ${txt.slice(0,300)}`);
        if (r.status === 401) setShowToken(true);
      } else {
        await refresh();
      }
    } finally { setBusy(null); }
  };

  const resetAll = async () => {
    let token = getAdminToken() || tokenInput;
    if (!token) {
      const t = prompt("Admin token required to reset all cooldowns:");
      if (!t) return;
      token = t;
      setTokenInput(t);
      setAdminToken(t);
    }
    if (!confirm(`Clear all ${providers.length} provider + ${models.length} model cooldowns?`)) return;
    setBusy("all");
    try {
      const r = await fetch("/api/admin/cooldown/reset", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-admin-token": token },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const txt = await r.text();
        alert(`Reset failed ${r.status}: ${txt.slice(0,300)}`);
      } else {
        await refresh();
      }
    } finally { setBusy(null); }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="text-sm font-semibold">Cooldowns — per-model vs per-provider timeout</div>
        <div className="flex gap-2 items-center">
          <span className={`text-xs px-2 py-1 rounded-full border ${hasAny ? "bg-amber-950/30 border-amber-800 text-amber-300" : "bg-emerald-950/30 border-emerald-800 text-emerald-300"}`}>
            {hasAny ? `${providers.length} provider • ${models.length} model cooling` : "No active cooldowns"}
          </span>
          {hasAny && <button onClick={resetAll} disabled={busy==="all"} className="text-xs px-3 py-1 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-50">Reset all</button>}
          <button onClick={()=>refresh()} className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700">↻</button>
        </div>
      </div>

      {showToken || !getAdminToken() ? (
        <div className="mt-3 flex gap-2 items-center">
          <input
            type="password"
            placeholder="Admin token for reset (saved locally)"
            value={tokenInput}
            onChange={(e)=>{ setTokenInput(e.target.value); setAdminToken(e.target.value); }}
            className="flex-1 rounded bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-xs"
          />
          <button onClick={()=>setShowToken(false)} className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700">Hide</button>
        </div>
      ) : (
        <button onClick={()=>setShowToken(true)} className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300 underline">Set admin token for reset</button>
      )}

      <div className="mt-3 grid md:grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
          <div className="text-xs font-semibold text-zinc-300 mb-2">Provider cooldowns (provider-wide, e.g. RATE_LIMITED) — proper timeout: provider refusing → provider timeout</div>
          {providers.length===0 ? <div className="text-xs text-zinc-500 py-2">No provider cooldowns — all providers under RPM budget.</div> : (
            <div className="space-y-1.5 max-h-[220px] overflow-auto">
              {providers.map(p=> (
                <div key={p.provider} className="flex gap-2 items-center rounded bg-amber-950/20 border border-amber-900/30 px-2 py-1.5">
                  <span className="text-xs font-mono font-medium text-amber-300 flex-1">{p.provider}</span>
                  <span className="text-[11px] text-zinc-400" title={p.reason ?? ""}>{(p.reason ?? "RATE_LIMITED").slice(0,40)}</span>
                  <span className="text-[11px] bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-300">{remainingStr(p.cooldown_until)}</span>
                  <button onClick={()=>resetProvider(p.provider, false)} disabled={busy===`p:${p.provider}`} className="text-[11px] px-2 py-1 rounded bg-emerald-900/30 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50">Reset</button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-[10px] text-zinc-500">Provider timeout shown only when provider returns 429/rate-limit. Displayed properly with remaining time.</div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
          <div className="text-xs font-semibold text-zinc-300 mb-2">Model cooldowns (model-specific, e.g. TIMEOUT/MODEL_UNAVAILABLE) — model issue → only that model timeout</div>
          {models.length===0 ? <div className="text-xs text-zinc-500 py-2">No model cooldowns — all models available (smart rotation ensures different models each cycle).</div> : (
            <div className="space-y-1.5 max-h-[220px] overflow-auto">
              {models.map(m=> (
                <div key={m.model_id} className="flex gap-2 items-center rounded bg-sky-950/20 border border-sky-900/30 px-2 py-1.5">
                  <span className="text-xs font-medium text-sky-300 flex-1 truncate">{m.provider_model_id} <span className="text-[11px] text-zinc-500">· {m.provider}</span></span>
                  <span className="text-[11px] text-zinc-400 truncate max-w-[140px]" title={m.reason ?? ""}>{(m.reason ?? "MODEL").slice(0,30)}</span>
                  <span className="text-[11px] bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-300">{remainingStr(m.cooldown_until)}</span>
                  <button onClick={()=>resetModel(m.model_id)} disabled={busy===`m:${m.model_id}`} className="text-[11px] px-2 py-1 rounded bg-emerald-900/30 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50">Reset</button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-[10px] text-zinc-500">Model timeout shown only when that model fails (TIMEOUT/MODEL_UNAVAILABLE). Provider stays available for other models.</div>
        </div>
      </div>

      <div className="mt-3 text-[11px] text-zinc-500">
        <b className="text-zinc-300">Smart RPM strategy:</b> Scheduler respects per-provider RPM (e.g. 10 RPM → 25 RPM blocked) via <span className="font-mono">benchmark_runs</span> 60s window + cooldowns, and rotates models by LRU (`least-recently-benchmarked` first) so subsequent hits use different models, not same model. Provider vs model timeout correctly distinguished and displayed; resettable from UI.
      </div>
    </div>
  );
}
