import { useState } from "react";
import { useCooldowns, remainingStr } from "../hooks/useCooldowns";
import { getCsrfToken } from "../lib/adminSession";

/** Admin auth for the ops panel (SEC-001).
 *
 *  Preferred path: the visitor is already signed in on the /admin page, so the
 *  session is in an HttpOnly cookie the browser attaches by itself and we only
 *  need the in-memory CSRF token. Nothing is read from storage and no
 *  credential enters JS.
 *
 *  Fallback path: someone opened this public panel without signing in. They
 *  type the token, it is used for that single request as a `Bearer` header,
 *  and it is deliberately NOT persisted — keeping it in localStorage is the
 *  exact exposure this change removes. */
function adminPostHeaders(fallbackToken?: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const csrf = getCsrfToken();
  if (csrf) h["X-CSRF-Token"] = csrf;
  if (!csrf && fallbackToken) h.authorization = `Bearer ${fallbackToken}`;
  return h;
}

export default function CooldownPanel() {
  const { data, refresh } = useCooldowns(10000);
  const [busy, setBusy] = useState<string | null>(null);
  // ponytail: collapsed by default — ops detail, keeps leaderboard + charts near the top
  const [open, setOpen] = useState(false);

  const providers = data?.providers ?? [];
  const models = data?.models ?? [];
  const hasAny = providers.length > 0 || models.length > 0;

  /** Ask for a one-shot Bearer token only when the visitor has no in-memory
   *  CSRF token (i.e. is not signed in). Never stored. */
  const needToken = (why: string): string | null => {
    const csrf = getCsrfToken();
    if (csrf) return null; // cookie session will authenticate the request
    const t = prompt(`${why} (ADMIN_TOKEN, used for this request only):`);
    return t && t.trim() ? t.trim() : null;
  };

  const resetProvider = async (provider: string, clearAll = false) => {
    const token = needToken("Admin token required to reset cooldown");
    if (!getCsrfToken() && !token) return;
    setBusy(`p:${provider}`);
    try {
      const r = await fetch("/api/admin/cooldown/reset", {
        method: "POST",
        headers: adminPostHeaders(token),
        body: JSON.stringify({ provider, clearAll }),
      });
      if (!r.ok) {
        const txt = await r.text();
        alert(
          `Reset failed ${r.status}: ${txt.slice(0, 300)}` +
            (r.status === 401 || r.status === 403
              ? " — sign in on the /admin page first."
              : ""),
        );
      } else {
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const resetModel = async (model_id: number) => {
    const token = needToken("Admin token required to reset cooldown");
    if (!getCsrfToken() && !token) return;
    setBusy(`m:${model_id}`);
    try {
      const r = await fetch("/api/admin/cooldown/reset", {
        method: "POST",
        headers: adminPostHeaders(token),
        body: JSON.stringify({ model_id }),
      });
      if (!r.ok) {
        const txt = await r.text();
        alert(
          `Reset failed ${r.status}: ${txt.slice(0, 300)}` +
            (r.status === 401 || r.status === 403
              ? " — sign in on the /admin page first."
              : ""),
        );
      } else {
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const resetAll = async () => {
    const token = needToken("Admin token required to reset all cooldowns");
    if (!getCsrfToken() && !token) return;
    if (
      !confirm(
        `Clear all ${providers.length} provider + ${models.length} model cooldowns?`,
      )
    )
      return;
    setBusy("all");
    try {
      const r = await fetch("/api/admin/cooldown/reset", {
        method: "POST",
        headers: adminPostHeaders(token),
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const txt = await r.text();
        alert(`Reset failed ${r.status}: ${txt.slice(0, 300)}`);
      } else {
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-sm font-semibold hover:text-white"
          title={open ? "Collapse" : "Expand"}
        >
          {open ? "▾" : "▸"} Cooldowns — per-model vs per-provider timeout
        </button>
        <div className="flex gap-2 items-center">
          <span
            className={`text-xs px-2 py-1 rounded-full border ${hasAny ? "bg-amber-950/30 border-amber-800 text-amber-300" : "bg-emerald-950/30 border-emerald-800 text-emerald-300"}`}
          >
            {hasAny
              ? `${providers.length} provider • ${models.length} model cooling`
              : "No active cooldowns"}
          </span>
          {open && hasAny && (
            <button
              onClick={resetAll}
              disabled={busy === "all"}
              className="text-xs px-3 py-1 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-50"
            >
              Reset all
            </button>
          )}
          <button
            onClick={() => refresh()}
            className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700"
          >
            ↻
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Token entry is gone (SEC-001): the /admin page signs you in with an
              HttpOnly cookie, and this panel reuses that session automatically.
              A typed token, if ever needed, is a one-shot prompt — never stored. */}

          <div className="mt-3 grid md:grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
              <div className="text-xs font-semibold text-zinc-300 mb-2">
                Provider cooldowns (provider-wide, e.g. RATE_LIMITED) — proper
                timeout: provider refusing → provider timeout
              </div>
              {providers.length === 0 ? (
                <div className="text-xs text-zinc-500 py-2">
                  No provider cooldowns — all providers under RPM budget.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[220px] overflow-auto">
                  {providers.map((p) => (
                    <div
                      key={p.provider}
                      className="flex gap-2 items-center rounded bg-amber-950/20 border border-amber-900/30 px-2 py-1.5"
                    >
                      <span className="text-xs font-mono font-medium text-amber-300 flex-1">
                        {p.provider}
                      </span>
                      <span
                        className="text-[11px] text-zinc-400"
                        title={p.reason ?? ""}
                      >
                        {((p.reason ?? "RATE_LIMITED").split(" ")[0] ?? "")
                          .split("{")[0]!
                          .slice(0, 32)}
                      </span>
                      <span className="text-[11px] bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-300">
                        {remainingStr(p.cooldown_until)}
                      </span>
                      <button
                        onClick={() => resetProvider(p.provider, false)}
                        disabled={busy === `p:${p.provider}`}
                        className="text-[11px] px-2 py-1 rounded bg-emerald-900/30 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50"
                      >
                        Reset
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 text-[10px] text-zinc-500">
                Provider timeout shown only when provider returns
                429/rate-limit. Displayed properly with remaining time.
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
              <div className="text-xs font-semibold text-zinc-300 mb-2">
                Model cooldowns (model-specific, e.g. TIMEOUT/MODEL_UNAVAILABLE)
                — model issue → only that model timeout
              </div>
              {models.length === 0 ? (
                <div className="text-xs text-zinc-500 py-2">
                  No model cooldowns — all models available (smart rotation
                  ensures different models each cycle).
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[220px] overflow-auto">
                  {models.map((m) => (
                    <div
                      key={m.model_id}
                      className="flex gap-2 items-center rounded bg-cyan-950/20 border border-cyan-900/30 px-2 py-1.5"
                    >
                      <span className="text-xs font-medium text-cyan-300 flex-1 truncate">
                        {m.provider_model_id}{" "}
                        <span className="text-[11px] text-zinc-500">
                          · {m.provider}
                        </span>
                      </span>
                      <span
                        className="text-[11px] text-zinc-400 truncate max-w-[140px]"
                        title={m.reason ?? ""}
                      >
                        {(m.reason ?? "MODEL").slice(0, 30)}
                      </span>
                      <span className="text-[11px] bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-300">
                        {remainingStr(m.cooldown_until)}
                      </span>
                      <button
                        onClick={() => resetModel(m.model_id)}
                        disabled={busy === `m:${m.model_id}`}
                        className="text-[11px] px-2 py-1 rounded bg-emerald-900/30 border border-emerald-800 text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50"
                      >
                        Reset
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 text-[10px] text-zinc-500">
                Model timeout shown only when that model fails
                (TIMEOUT/MODEL_UNAVAILABLE). Provider stays available for other
                models.
              </div>
            </div>
          </div>

          <div className="mt-3 text-[11px] text-zinc-500">
            <b className="text-zinc-300">Smart RPM strategy:</b> Scheduler
            respects per-provider RPM (e.g. 10 RPM → 25 RPM blocked) via{" "}
            <span className="font-mono">benchmark_runs</span> 60s window +
            cooldowns, and rotates models by LRU (`least-recently-benchmarked`
            first) so subsequent hits use different models, not same model.
            Provider vs model timeout correctly distinguished and displayed;
            resettable from UI.
          </div>
        </>
      )}
    </div>
  );
}
