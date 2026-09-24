import { useEffect, useMemo, useRef, useState } from "react";
import {
  BUILTIN_PRESETS,
  deleteCustomPreset,
  loadCustomPresets,
  saveCustomPreset,
  type PromptPreset,
} from "./presets";

const TOKEN_KEY = "modelpulsex_admin_token";
const authHeader = (): Record<string, string> => {
  const t = localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
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
  debug: unknown | null;
};

const PROBE_APIS = [
  "/api/health",
  "/api/providers",
  "/api/models?limit=1",
  "/api/leaderboard?range=1h",
];

export default function Playground() {
  const [endpoints, setEndpoints] = useState<RegistryEndpoint[]>([]);
  const [modelHints, setModelHints] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState(BUILTIN_PRESETS[0]!.prompt);
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [topP, setTopP] = useState("1");
  const [maxTokens, setMaxTokens] = useState("256");
  const [timeoutMs, setTimeoutMs] = useState("60000");
  const [presetId, setPresetId] = useState(BUILTIN_PRESETS[0]!.id);
  const [custom, setCustom] = useState<PromptPreset[]>(() => loadCustomPresets());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [probePath, setProbePath] = useState(PROBE_APIS[0]!);
  const [probeOut, setProbeOut] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
          models?: { provider_name: string; provider_model_id: string }[];
        };
        setModelHints(
          (j.models ?? []).map((m) => `${m.provider_name} / ${m.provider_model_id}`),
        );
      } catch {
        // hints are best-effort; free-text model id still works
      }
    })();
    // NOTE: mount-only fetch; functional setProvider avoids stale reads.
  }, []);

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

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = allPresets.find((x) => x.id === id);
    if (p) {
      setPrompt(p.prompt);
      setMaxTokens(String(p.max_tokens));
    }
  };

  const run = async () => {
    if (running) return;
    setErr(null);
    setResult(null);
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

  const downloadDebugLog = () => {
    if (!result?.debug) return;
    const safe = (s: string) => s.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80);
    const bundle = {
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
      },
      free_status: result.free_status,
      would_queue_in_cron: result.would_queue_in_cron,
      result: result.result,
      answer_preview: result.preview,
      debug: result.debug,
    };
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
              onChange={(e) => setProvider(e.target.value)}
              className={inputCls}
            >
              {endpoints.map((e) => (
                <option key={e.name} value={e.name}>{e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pg-model" className={labelCls}>Model id</label>
            <input
              id="pg-model"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. big-pickle"
              list="pg-model-hints"
              className={`${inputCls} font-mono`}
            />
            <datalist id="pg-model-hints">
              {hintsForProvider.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </div>
          <div className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2">
            <div className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium">Endpoint (from registry)</div>
            <div className="font-mono text-[11px] text-violet-300 break-all mt-1">
              {selectedEndpoint?.chatUrl ?? "—"}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1">
              Custom base URLs are not allowed — server exact-matches the registry.
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="pg-temp" className={labelCls}>Temperature 0–2</label>
              <input id="pg-temp" value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" inputMode="decimal" className={inputCls} />
            </div>
            <div>
              <label htmlFor="pg-topp" className={labelCls}>Top_p 0–1</label>
              <input id="pg-topp" value={topP} onChange={(e) => setTopP(e.target.value)} placeholder="1" inputMode="decimal" className={inputCls} />
            </div>
            <div>
              <label htmlFor="pg-maxtok" className={labelCls}>Max tokens 16–2048</label>
              <input id="pg-maxtok" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} inputMode="numeric" className={inputCls} />
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
            <textarea id="pg-system" value={system} onChange={(e) => setSystem(e.target.value)} rows={2} placeholder="Be concise." className={`${inputCls} font-mono`} />
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
                setCustom(saveCustomPreset({ id, label: `Custom ${custom.length + 1}`, prompt, max_tokens: Number(maxTokens) || 256 }));
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
          <div className="flex gap-2">
            <button
              onClick={run}
              disabled={running || !provider || !modelId.trim() || !prompt.trim()}
              className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed min-h-6"
            >
              {running ? "Running…" : "Run test"}
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
            {result.result.error_type && (
              <div className="font-mono text-xs text-amber-200/80 break-all">{result.result.error_type.slice(0, 500)}</div>
            )}
            {result.result.error_type?.includes("reasoning_no_content") && (
              <div className="text-xs text-zinc-400 leading-relaxed">
                This model produced reasoning but no answer text within the token budget.
                Reasoning models need headroom — retry with Max tokens 1024–2048 or a shorter prompt.
                (The scheduled benchmark uses 4092 tokens for the same reason.)
              </div>
            )}
            <div>
              <div className="text-[11px] tracking-widest uppercase text-zinc-500 font-medium mb-1">Answer preview (first 2000 chars, not stored)</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-200 rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 max-h-64 overflow-auto">
                {result.preview || "(no text returned)"}
              </pre>
            </div>
            {result.debug ? (
              <div className="flex flex-wrap gap-2 items-center">
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
