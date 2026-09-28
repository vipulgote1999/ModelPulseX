import { useEffect, useMemo, useRef, useState } from "react";
import {
  BUILTIN_PRESETS,
  deleteCustomPreset,
  loadCustomPresets,
  saveCustomPreset,
  type PromptPreset,
} from "./presets";
import { getCsrfToken } from "../../lib/adminSession";

// SEC-001: the admin token is no longer in JS. The session is an HttpOnly
// cookie the browser sends automatically; only the in-memory CSRF token is
// attached here. `authHeader` is retained as a name for minimal diff — it
// returns CSRF headers, not credentials.
const authHeader = (): Record<string, string> => {
  const t = getCsrfToken();
  return t ? { "X-CSRF-Token": t } : {};
};

type RegistryEndpoint = {
  name: string;
  baseUrl: string;
  modelsUrl: string;
  chatUrl: string;
};

type PlaygroundResult = {
  ok: boolean;
  provider: string;
  model: string;
  resolvedChatUrl: string;
  custom_url_used: boolean;
  free_status: string;
  would_queue_in_cron: boolean;
  result: {
    status: string;
    http_status: number | null;
    ttft_ms: number | null;
    tps: number | null;
    generation_ms: number | null;
    itl_ms: number | null;
    chunk_count: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    token_estimation_method: string;
    error_type: string | null;
  };
  preview: string;
  preview_truncated: boolean;
  debug: unknown | null;
};

const PROBE_APIS = [
  "/api/health",
  "/api/providers",
  "/api/models?limit=1",
  "/api/leaderboard?range=1h",
];

/** Small absolute-positioned copy button for <pre> blocks. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard unavailable — user selects manually
        }
      }}
      className="absolute top-2 right-2 rounded-md border border-zinc-700 bg-zinc-900/90 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-white"
      title={`Copy ${label} to clipboard`}
    >
      {done ? "Copied ✓" : `Copy ${label}`}
    </button>
  );
}

/** Split a raw provider error body into a short code + full human message.
 *  Non-JSON bodies (plain text, HTML) are returned verbatim. */
function parseErrorType(raw: string): { code: string | null; message: string } {
  try {
    const j = JSON.parse(raw) as unknown;
    const err =
      typeof j === "object" && j !== null && "error" in j
        ? (j as { error: unknown }).error
        : j;
    if (typeof err === "object" && err !== null) {
      const rec = err as Record<string, unknown>;
      const message =
        typeof rec.message === "string" ? rec.message : null;
      if (message) {
        return {
          code: typeof rec.code === "string" ? rec.code : null,
          message,
        };
      }
    }
    if (typeof j === "string" && j) return { code: null, message: j };
  } catch {
    // not JSON — fall through to raw
  }
  return { code: null, message: raw };
}

export default function Playground() {
  const [endpoints, setEndpoints] = useState<RegistryEndpoint[]>([]);
  const [modelHints, setModelHints] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<
    Array<{ provider: string; id: string; active: number; free: string }>
  >([]);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [modelHi, setModelHi] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const autoPicked = useRef(false);
  const modelBoxRef = useRef<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = useState(BUILTIN_PRESETS[0]!.prompt);
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [topP, setTopP] = useState("0.95");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [timeoutMs, setTimeoutMs] = useState("60000");
  const [presetId, setPresetId] = useState(BUILTIN_PRESETS[0]!.id);
  const [custom, setCustom] = useState<PromptPreset[]>(() => loadCustomPresets());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [probePath, setProbePath] = useState(PROBE_APIS[0]!);
  const [probeOut, setProbeOut] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  // Session-only provider key: tab-scoped (sessionStorage), cleared on tab
  // close, sent with a single request only, never stored server-side.
  const [sessionKey, setSessionKey] = useState(() => {
    try {
      return sessionStorage.getItem("modelpulsex_playground_key") ?? "";
    } catch {
      return "";
    }
  });
  const [showKey, setShowKey] = useState(false);
  const [usedKey, setUsedKey] = useState(false);
  // Session-only endpoint override: free-text chat URL for this test alone.
  // Empty = registry default. Never stored; SSRF-guarded server-side.
  const [customUrl, setCustomUrl] = useState("");
  const [usedCustomUrl, setUsedCustomUrl] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [prevMaxTokens, setPrevMaxTokens] = useState<string | null>(null);
  const [usedThinking, setUsedThinking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const setKey = (v: string) => {
    setSessionKey(v);
    try {
      if (v) sessionStorage.setItem("modelpulsex_playground_key", v);
      else sessionStorage.removeItem("modelpulsex_playground_key");
    } catch {
      // private mode — key lives in memory only for this page view
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/providers");
        if (!res.ok) return;
        const j = (await res.json()) as { registry?: RegistryEndpoint[] };
        const reg = (j.registry ?? []).sort((a, b) => a.name.localeCompare(b.name));
        setEndpoints(reg);
        setProvider((prev) => (prev === "" && reg.length > 0 ? reg[0]!.name : prev));
      } catch {
        // public endpoint unreachable — select stays empty with error on run
      }
    })();
    (async () => {
      try {
        const res = await fetch("/api/admin/models", { headers: authHeader() });
        if (!res.ok) return;
        const j = (await res.json()) as {
          models?: {
            provider_name: string;
            provider_model_id: string;
            active?: number;
            free_status?: string;
          }[];
        };
        const list = j.models ?? [];
        setModelHints(
          list.map((m) => `${m.provider_name} / ${m.provider_model_id}`),
        );
        setModelOptions(
          list.map((m) => ({
            provider: m.provider_name,
            id: m.provider_model_id,
            active: m.active ?? 1,
            free: m.free_status ?? "UNKNOWN",
          })),
        );
      } catch {
        // hints are best-effort; free-text model id still works
      }
    })();
    // NOTE: mount-only fetch; functional setProvider avoids stale reads.
  }, []);

  // Auto-pick a sensible default model: first active, else first FREE, else first.
  useEffect(() => {
    if (autoPicked.current || modelId !== "" || modelOptions.length === 0)
      return;
    const pick =
      modelOptions.find((m) => m.active === 1) ??
      modelOptions.find((m) => m.free === "FREE") ??
      modelOptions[0];
    if (!pick) return;
    autoPicked.current = true;
    if (endpoints.length === 0 || endpoints.some((e) => e.name === pick.provider)) {
      setProvider(pick.provider);
    }
    setModelId(pick.id);
  }, [modelOptions, endpoints, modelId]);

  // Close model dropdown on outside click.
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!modelBoxRef.current?.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [modelOpen]);

  const selectedEndpoint = useMemo(
    () => endpoints.find((e) => e.name === provider) ?? null,
    [endpoints, provider],
  );
  const allPresets = useMemo(
    () => [...BUILTIN_PRESETS, ...custom],
    [custom],
  );
  const hintsForProvider = useMemo(() => {
    const ids = modelHints
      .filter((h) => h.startsWith(`${provider} / `))
      .map((h) => h.slice(provider.length + 3));
    return ids.slice(0, 200);
  }, [modelHints, provider]);

  // Rich filtered options for the combobox: prefer meta (active/free badges),
  // fall back to plain hint strings when meta is unavailable.
  const modelMatches = useMemo(() => {
    const q = modelId.trim().toLowerCase();
    const fromMeta = modelOptions
      .filter((m) => (provider ? m.provider === provider : true))
      .filter((m) => (q ? m.id.toLowerCase().includes(q) : true))
      .slice(0, 50);
    if (fromMeta.length > 0 || modelOptions.length > 0) return fromMeta;
    return hintsForProvider
      .filter((id) => (q ? id.toLowerCase().includes(q) : true))
      .slice(0, 50)
      .map((id) => ({ provider, id, active: 1, free: "" }));
  }, [modelOptions, hintsForProvider, provider, modelId]);

  const chooseModel = (id: string, prov?: string) => {
    setModelId(id);
    if (prov && prov !== provider) setProvider(prov);
    setModelOpen(false);
    setModelHi(0);
  };

  // Switching provider clears the stale model id and auto-picks the first
  // active model for the new provider (else first FREE, else first hint).
  // A custom endpoint URL is also reset — it belonged to the old provider.
  const changeProvider = (name: string) => {
    setProvider(name);
    setModelOpen(false);
    setModelHi(0);
    setCustomUrl("");
    const opts = modelOptions.filter((m) => m.provider === name);
    const pick =
      opts.find((m) => m.active === 1) ??
      opts.find((m) => m.free === "FREE") ??
      opts[0];
    if (pick) {
      setModelId(pick.id);
      return;
    }
    const hint = modelHints
      .filter((h) => h.startsWith(`${name} / `))
      .map((h) => h.slice(name.length + 3))[0];
    setModelId(hint ?? "");
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = allPresets.find((x) => x.id === id);
    if (p) {
      setPrompt(p.prompt);
      setMaxTokens(String(p.max_tokens));
      // A preset defines its own budget — explicit choice wins over the toggle.
      setThinking(false);
      setPrevMaxTokens(null);
    }
  };

  // Thinking mode: one-tap full reasoning headroom (2048-token ceiling).
  // Reasoning models burn budget on thinking before answering; toggling off
  // restores the previous budget. Pure UI — the request just carries max_tokens.
  const toggleThinking = () => {
    if (thinking) {
      setThinking(false);
      if (prevMaxTokens != null) setMaxTokens(prevMaxTokens);
      setPrevMaxTokens(null);
    } else {
      setPrevMaxTokens(maxTokens);
      setMaxTokens("2048");
      setThinking(true);
    }
  };

  const run = async () => {
    if (running) return;
    setErr(null);
    setResult(null);
    setShowLog(false);
    setUsedKey(false);
    setUsedCustomUrl(false);
    setUsedThinking(thinking);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    try {
      const body: Record<string, unknown> = {
        provider,
        provider_model_id: modelId.trim(),
        prompt,
        max_tokens: Number(maxTokens),
        timeout_ms: Number(timeoutMs),
      };
      if (system.trim()) body.system = system;
      const t = temperature.trim();
      if (t !== "") body.temperature = Number(t);
      const tp = topP.trim();
      if (tp !== "") body.top_p = Number(tp);
      if (sessionKey.trim()) {
        body.apiKey = sessionKey.trim();
        setUsedKey(true);
      }
      if (customUrl.trim()) {
        body.chatUrl = customUrl.trim();
        setUsedCustomUrl(true);
      }
      const res = await fetch("/api/admin/playground/test", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const j = (await res.json()) as PlaygroundResult & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setResult(j);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setErr("Cancelled.");
      } else {
        setErr(String(e instanceof Error ? e.message : e));
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  // Debug bundle shared by download + inline preview. The session key is
  // deliberately never included — debug headers are REDACTED server-side.
  const buildDebugBundle = () => {
    if (!result?.debug) return null;
    return {
      exported_at: new Date().toISOString(),
      exporter: "modelpulsex-admin-playground",
      ui: {
        provider,
        provider_model_id: modelId.trim(),
        preset: presetId,
        prompt,
        system: system || null,
        temperature: temperature.trim() || null,
        top_p: topP.trim() || null,
        max_tokens: maxTokens,
        timeout_ms: timeoutMs,
        session_key_used: usedKey,
        custom_chat_url: usedCustomUrl ? customUrl.trim() : null,
        thinking_mode: usedThinking,
      },
      free_status: result.free_status,
      would_queue_in_cron: result.would_queue_in_cron,
      result: result.result,
      answer_preview: result.preview,
      debug: result.debug,
    };
  };

  const debugJson = result?.debug
    ? JSON.stringify(buildDebugBundle(), null, 2)
    : null;

  const downloadDebugLog = () => {
    const bundle = buildDebugBundle();
    if (!bundle) return;
    const safe = (s: string) => s.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `playground-${safe(provider)}-${safe(modelId.trim() || "model")}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const probe = async () => {    setProbeBusy(true);
    setProbeOut(null);
    try {
      const res = await fetch(probePath, { headers: authHeader() });
      const text = await res.text();
      setProbeOut(`HTTP ${res.status}\n${text.slice(0, 4000)}`);
    } catch (e) {
      setProbeOut(String(e instanceof Error ? e.message : e));
    } finally {
      setProbeBusy(false);
    }
  };

  const inputCls =
    "mt-1 w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-600";
  const labelCls =
    "text-xs font-medium text-zinc-400 tracking-widest uppercase";

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        {/* config column */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 space-y-4">
          <div>
            <label htmlFor="pg-provider" className={labelCls}>Provider (registry-only)</label>
            <select
              id="pg-provider"
              value={provider}
              onChange={(e) => changeProvider(e.target.value)}
              className={inputCls}
            >
              {endpoints.map((e) => (
                <option key={e.name} value={e.name}>{e.name}</option>
              ))}
            </select>
          </div>
          <div ref={modelBoxRef} className="relative">
            <label htmlFor="pg-model" className={labelCls}>Model id</label>
            <input
              id="pg-model"
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value);
                setModelOpen(true);
                setModelHi(0);
              }}
              onFocus={() => {
                setModelOpen(true);
                setModelHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (!modelOpen) {
                    setModelOpen(true);
                    return;
                  }
                  const n = modelMatches.length;
                  if (n === 0) return;
                  setModelHi((h) =>
                    e.key === "ArrowDown" ? (h + 1) % n : (h - 1 + n) % n,
                  );
                } else if (e.key === "Enter") {
                  if (modelOpen && modelMatches[modelHi]) {
                    e.preventDefault();
                    const m = modelMatches[modelHi]!;
                    chooseModel(m.id, m.provider);
                  }
                } else if (e.key === "Escape") {
                  setModelOpen(false);
                }
              }}
              placeholder="e.g. big-pickle"
              autoComplete="off"
              role="combobox"
              aria-expanded={modelOpen}
              aria-controls="pg-model-listbox"
              aria-activedescendant={
                modelOpen && modelMatches[modelHi]
                  ? `pg-model-opt-${modelHi}`
                  : undefined
              }
              className={`${inputCls} font-mono`}
            />
            {modelOpen && modelMatches.length > 0 && (
              <ul
                id="pg-model-listbox"
                role="listbox"
                aria-label="Matching models"
                className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-zinc-700 bg-zinc-950 shadow-xl"
              >
                {modelMatches.map((m, i) => (
                  <li
                    key={`${m.provider}/${m.id}`}
                    id={`pg-model-opt-${i}`}
                    role="option"
                    aria-selected={modelId === m.id || i === modelHi}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      chooseModel(m.id, m.provider);
                    }}
                    onMouseEnter={() => setModelHi(i)}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-xs ${
                      i === modelHi
                        ? "bg-violet-600/30 text-zinc-100"
                        : "text-zinc-300"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate" title={`${m.provider} / ${m.id}`}>
                      {m.id}
                    </span>
                    {m.free === "FREE" && (
                      <span className="shrink-0 rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-px text-[10px] text-emerald-300">
                        FREE
                      </span>
                    )}
                    {m.active !== 1 && (
                      <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-px text-[10px] text-zinc-500">
                        inactive
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1 text-[11px] text-zinc-500">
              {modelOptions.length > 0
                ? `↑↓ to navigate · Enter to select · ${modelMatches.length} match${modelMatches.length === 1 ? "" : "es"}${provider ? ` for ${provider}` : ""}`
                : "Type to filter — ↑↓ Enter to pick."}
            </div>
          </div>
          <div className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium">Endpoint (from registry)</div>
              {customUrl ? (
                <button
                  onClick={() => setCustomUrl("")}
                  className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  title="Back to the registry URL"
                >
                  Reset
                </button>
              ) : (
                <button
                  onClick={() => setCustomUrl(selectedEndpoint?.chatUrl ?? "")}
                  className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  title="Edit the chat URL for this test only"
                >
                  Customize
                </button>
              )}
            </div>
            {customUrl ? (
              <input
                id="pg-url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://…/chat/completions"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 font-mono text-[11px] text-violet-200 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 break-all"
              />
            ) : (
              <div className="font-mono text-[11px] text-violet-300 break-all mt-1">
                {selectedEndpoint?.chatUrl ?? "—"}
              </div>
            )}
            <div className="text-[11px] text-zinc-500 mt-1">
              {customUrl
                ? "Custom URL for this test only — https only, never stored. Cron still uses the registry."
                : "Registry default. Customize for a one-off test — cron still uses the registry."}
            </div>
          </div>
          <div className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2">
            <label htmlFor="pg-key" className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium">
              Session API key (optional)
            </label>
            <div className="flex gap-2 mt-1">
              <input
                id="pg-key"
                type={showKey ? "text" : "password"}
                value={sessionKey}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Paste provider key…"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-600"
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="shrink-0 rounded-md border border-zinc-800 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                title={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? "Hide" : "Show"}
              </button>
              {sessionKey && (
                <button
                  onClick={() => setKey("")}
                  className="shrink-0 rounded-md border border-zinc-800 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  title="Remove session key"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1">
              Tab-only: kept in sessionStorage, cleared when the tab closes.
              Sent with this request alone — never stored server-side, never in logs (REDACTED).
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pg-temp" className={labelCls}>Temperature 0–2</label>
              <input id="pg-temp" value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" inputMode="decimal" className={inputCls} />
            </div>
            <div>
              <label htmlFor="pg-topp" className={labelCls}>Top_p 0–1</label>
              <input id="pg-topp" value={topP} onChange={(e) => setTopP(e.target.value)} placeholder="0.95" inputMode="decimal" className={inputCls} />
            </div>
            <div>
              <label htmlFor="pg-maxtok" className={labelCls}>Max tokens 16–2048{thinking ? " (thinking)" : ""}</label>
              <input id="pg-maxtok" value={maxTokens} onChange={(e) => { setMaxTokens(e.target.value); setThinking(false); setPrevMaxTokens(null); }} inputMode="numeric" className={inputCls} />
            </div>
            <div>
              <label htmlFor="pg-timeout" className={labelCls}>Timeout</label>
              <select id="pg-timeout" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} className={inputCls}>
                <option value="15000">15s</option>
                <option value="30000">30s</option>
                <option value="60000">60s</option>
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="pg-system" className={labelCls}>System prompt (optional)</label>
            <textarea id="pg-system" value={system} onChange={(e) => setSystem(e.target.value)} rows={2} placeholder="You are a helpful assistant. Be concise." className={`${inputCls} font-mono`} />
          </div>
        </div>

        {/* prompt + run column */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 space-y-3">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[200px]">
              <label htmlFor="pg-preset" className={labelCls}>Sample prompt preset</label>
              <select id="pg-preset" value={presetId} onChange={(e) => applyPreset(e.target.value)} className={inputCls}>
                {allPresets.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => {
                const id = `custom-${Date.now()}`;
                setCustom(saveCustomPreset({ id, label: `Custom ${custom.length + 1}`, prompt, max_tokens: Number(maxTokens) || 1024 }));
                setPresetId(id);
              }}
              className="rounded-md border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
            >
              Save current as preset
            </button>
            {presetId.startsWith("custom-") && (
              <button
                onClick={() => {
                  setCustom(deleteCustomPreset(presetId));
                  applyPreset(BUILTIN_PRESETS[0]!.id);
                }}
                className="rounded-md border border-zinc-800 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
              >
                Delete preset
              </button>
            )}
          </div>
          <div>
            <label htmlFor="pg-prompt" className={labelCls}>Prompt (editable, {prompt.length}/4000)</label>
            <textarea
              id="pg-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
              }}
              className={`${inputCls} font-mono`}
            />
            <div className="text-[11px] text-zinc-500 mt-1">Cmd/Ctrl+Enter to run. Esc cancels while running.</div>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <button
              onClick={run}
              disabled={running || !provider || !modelId.trim() || !prompt.trim()}
              className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed min-h-6"
            >
              {running ? "Running…" : "Run test"}
            </button>
            <button
              onClick={toggleThinking}
              aria-pressed={thinking}
              title={thinking ? "Thinking mode on: 2048-token budget. Click to restore." : "Thinking mode: full 2048-token budget for reasoning models"}
              className={`rounded-md border px-4 py-2 text-sm font-medium min-h-6 ${thinking ? "bg-violet-950/60 border-violet-600 text-violet-200" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
            >
              {thinking ? "Thinking: on" : "Thinking: off"}
            </button>
            {running && (
              <button
                onClick={() => abortRef.current?.abort()}
                className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 min-h-6"
              >
                Cancel
              </button>
            )}
          </div>
          {err && (
            <div role="alert" className="rounded-md bg-amber-950/40 border border-amber-800 px-3 py-2 text-sm text-amber-200">
              {err}
            </div>
          )}
        </div>
      </div>

      {/* results */}
      <div aria-live="polite" className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
        {!result ? (
          <div className="text-sm text-zinc-500">
            {running ? "Waiting for first token…" : "Run a test to see TTFT / TPS / status and a 2000-char answer preview. Results are ephemeral — they clear on refresh and are never stored."}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 items-center text-xs">
              <span className={`inline-flex rounded px-2 py-0.5 font-medium border ${result.result.status === "SUCCESS" ? "bg-emerald-950/30 border-emerald-800 text-emerald-300" : "bg-amber-950/20 border-amber-800 text-amber-300"}`}>
                {result.result.status}
              </span>
              <span className="text-zinc-400">HTTP {result.result.http_status ?? "—"}</span>
              <span className="text-zinc-400">free_status {result.free_status}</span>
              {usedKey && (
                <span
                  className="inline-flex rounded px-2 py-0.5 border bg-violet-950/40 border-violet-800 text-violet-300"
                  title="This run used your tab-only session key instead of the server key"
                >
                  session key
                </span>
              )}
              {(usedCustomUrl || result.custom_url_used) && (
                <span
                  className="inline-flex rounded px-2 py-0.5 border bg-violet-950/40 border-violet-800 text-violet-300"
                  title={`This run used a custom endpoint URL: ${result.resolvedChatUrl}`}
                >
                  custom URL
                </span>
              )}
              {usedThinking && (
                <span
                  className="inline-flex rounded px-2 py-0.5 border bg-violet-950/40 border-violet-800 text-violet-300"
                  title="This run used thinking mode: full 2048-token budget for reasoning headroom"
                >
                  thinking
                </span>
              )}
              {!result.would_queue_in_cron && (
                <span className="inline-flex rounded px-2 py-0.5 border bg-zinc-800 border-zinc-700 text-zinc-300">
                  Would skip cron queue (needs FREE + active + enabled)
                </span>
              )}
              <span className="text-zinc-500 ml-auto">tokens via {result.result.token_estimation_method}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ["TTFT ms", result.result.ttft_ms],
                ["TPS", result.result.tps != null ? result.result.tps.toFixed(1) : null],
                ["Generation ms", result.result.generation_ms],
                ["ITL ms", result.result.itl_ms != null ? result.result.itl_ms.toFixed(1) : null],
                ["Chunks", result.result.chunk_count],
                ["In tokens", result.result.input_tokens],
                ["Out tokens", result.result.output_tokens],
              ].map(([label, v]) => (
                <div key={label as string} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                  <div className="text-[11px] tracking-widest uppercase text-zinc-500">{label}</div>
                  <div className="text-lg font-mono mt-0.5">{v ?? "—"}</div>
                </div>
              ))}
            </div>
            {result.result.error_type && (() => {
              const parsed = parseErrorType(result.result.error_type!);
              const isRaw = parsed.message === result.result.error_type;
              return (
                <div className="rounded-md border border-amber-800 bg-amber-950/30 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-amber-200">
                      Error{parsed.code ? ` · ${parsed.code}` : ""}
                    </span>
                    <span className="text-amber-200/60">
                      HTTP {result.result.http_status ?? "—"}
                    </span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-amber-100/90">
                    {parsed.message}
                  </div>
                  {!isRaw && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-amber-200/70 hover:text-amber-200">
                        Raw response body
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-amber-200/70">
                        {result.result.error_type}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })()}
            {result.result.error_type?.includes("reasoning_no_content") && (
              <div className="text-xs text-zinc-400 leading-relaxed">
                This model produced reasoning but no answer text within the token budget.
                Reasoning models need headroom — retry with Max tokens 1024–2048 or a shorter prompt.
                (The scheduled benchmark uses 4092 tokens for the same reason.)
              </div>
            )}
            <div>
              <div className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium mb-1">
                Answer ({result.preview.length} chars, not stored)
                {result.preview_truncated ? " — truncated" : ""}
              </div>
              <div className="relative">
                {result.preview && (
                  <CopyButton text={result.preview} label="answer" />
                )}
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-200 rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 max-h-64 overflow-auto">
                  {result.preview || "(no text returned)"}
                </pre>
              </div>
            </div>
            {result.debug ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 items-center">
                  <button
                    onClick={() => setShowLog((v) => !v)}
                    className="rounded-md border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 min-h-6"
                    aria-expanded={showLog}
                  >
                    {showLog ? "Hide log preview" : "Preview log"}
                  </button>
                  <button
                    onClick={downloadDebugLog}
                    className="rounded-md border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 min-h-6"
                  >
                    Download debug log (.json)
                  </button>
                  <span className="text-[11px] text-zinc-500">
                    Request payload + URL + redacted headers + response/SSE transcript. Secrets are REDACTED — reproduce locally with your own key.
                  </span>
                </div>
                {showLog && debugJson && (
                  <div className="relative">
                    <CopyButton text={debugJson} label="log" />
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-300 rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 max-h-96 overflow-auto">
                      {debugJson}
                    </pre>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* internal API probe */}
      <details className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
        <summary className="text-sm font-semibold cursor-pointer">Internal API probe</summary>
        <div className="flex flex-wrap gap-2 mt-3 items-end">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor="pg-probe" className={labelCls}>GET endpoint</label>
            <select id="pg-probe" value={probePath} onChange={(e) => setProbePath(e.target.value)} className={`${inputCls} font-mono`}>
              {PROBE_APIS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <button onClick={probe} disabled={probeBusy} className="rounded-md border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40">
            {probeBusy ? "Probing…" : "Probe"}
          </button>
        </div>
        {probeOut && (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-300 rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 mt-3 max-h-64 overflow-auto">
            {probeOut}
          </pre>
        )}
      </details>
    </div>
  );
}
