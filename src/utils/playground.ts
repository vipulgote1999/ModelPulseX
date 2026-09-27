/** Playground input validation + clamps — pure, Cloudflare-free, unit-tested.
 *  Session-only overrides (apiKey, chatUrl) are allowed for this ephemeral
 *  request alone: never persisted, never logged. URL shape is checked here;
 *  SSRF safety (https-only, no creds) is enforced by assertSafeApiUrl
 *  in the route. Ephemeral: validation never touches D1/queues.
 */
import { PROVIDER_REGISTRY } from "../providers/registry";
import type { BenchmarkDefinition } from "../types";

export interface PlaygroundInput {
  provider?: unknown;
  provider_model_id?: unknown;
  prompt?: unknown;
  system?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
  timeout_ms?: unknown;
  /** Optional caller-supplied key for this ephemeral request only.
   *  Never persisted, never logged — the engine redacts it from debug. */
  apiKey?: unknown;
  /** Optional caller-supplied chat-completions URL override for this
   *  ephemeral request only. Must pass assertSafeApiUrl server-side. */
  chatUrl?: unknown;
}

export interface ValidPlayground {
  provider: string;
  provider_model_id: string;
  prompt: string;
  system_prompt?: string;
  benchmark: BenchmarkDefinition;
  /** Session-only override; when absent the server env key is used. */
  apiKey?: string;
  /** Session-only chat URL override; when absent the registry URL is used. */
  chatUrl?: string;
}

export const PLAYGROUND_LIMITS = {
  promptMin: 1,
  promptMax: 4000,
  systemMax: 4000,
  tempMin: 0,
  tempMax: 2,
  topPMin: 0,
  topPMax: 1,
  maxTokensMin: 16,
  // 2048: reasoning models burn budget on thinking before answering (the cron
  // coding workload carries 4092 for the same reason). 512 starves them into
  // reasoning_no_content cutoffs. The 60s timeout still bounds wall-time/cost.
  maxTokensMax: 2048,
  timeoutMin: 5000,
  timeoutMax: 60000,
} as const;

export function isKnownProvider(name: string): boolean {
  return PROVIDER_REGISTRY.some((d) => d.name === name);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Validate raw playground body. Returns ok flag + error or normalized workload. */
export function validatePlaygroundInput(
  raw: PlaygroundInput,
): { ok: true; value: ValidPlayground } | { ok: false; error: string } {
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (!provider) return { ok: false, error: "provider required" };
  if (!isKnownProvider(provider))
    return { ok: false, error: `unknown provider: ${provider.slice(0, 80)}` };

  const modelId =
    typeof raw.provider_model_id === "string"
      ? raw.provider_model_id.trim()
      : "";
  if (!modelId) return { ok: false, error: "provider_model_id required" };
  if (modelId.length > 200)
    return { ok: false, error: "provider_model_id too long (max 200)" };

  const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
  if (prompt.trim().length < PLAYGROUND_LIMITS.promptMin)
    return { ok: false, error: "prompt required" };
  if (prompt.length > PLAYGROUND_LIMITS.promptMax)
    return {
      ok: false,
      error: `prompt too long (max ${PLAYGROUND_LIMITS.promptMax} chars)`,
    };

  let system_prompt: string | undefined;
  if (raw.system !== undefined && raw.system !== null && raw.system !== "") {
    if (typeof raw.system !== "string")
      return { ok: false, error: "system must be a string" };
    if (raw.system.length > PLAYGROUND_LIMITS.systemMax)
      return {
        ok: false,
        error: `system too long (max ${PLAYGROUND_LIMITS.systemMax} chars)`,
      };
    system_prompt = raw.system;
  }

  let temperature: number | undefined;
  if (raw.temperature !== undefined && raw.temperature !== null && raw.temperature !== "") {
    const n = asNumber(raw.temperature);
    if (n == null || n < PLAYGROUND_LIMITS.tempMin || n > PLAYGROUND_LIMITS.tempMax)
      return {
        ok: false,
        error: `temperature must be ${PLAYGROUND_LIMITS.tempMin}-${PLAYGROUND_LIMITS.tempMax}`,
      };
    temperature = n;
  }

  let top_p: number | undefined;
  if (raw.top_p !== undefined && raw.top_p !== null && raw.top_p !== "") {
    const n = asNumber(raw.top_p);
    if (n == null || n < PLAYGROUND_LIMITS.topPMin || n > PLAYGROUND_LIMITS.topPMax)
      return {
        ok: false,
        error: `top_p must be ${PLAYGROUND_LIMITS.topPMin}-${PLAYGROUND_LIMITS.topPMax}`,
      };
    top_p = n;
  }

  const maxTokensRaw = asNumber(raw.max_tokens);
  const max_tokens =
    maxTokensRaw == null ? 256 : Math.floor(maxTokensRaw);
  if (max_tokens < PLAYGROUND_LIMITS.maxTokensMin || max_tokens > PLAYGROUND_LIMITS.maxTokensMax)
    return {
      ok: false,
      error: `max_tokens must be ${PLAYGROUND_LIMITS.maxTokensMin}-${PLAYGROUND_LIMITS.maxTokensMax}`,
    };

  const timeoutRaw = asNumber(raw.timeout_ms);
  const timeout_ms = timeoutRaw == null ? 60000 : Math.floor(timeoutRaw);
  if (timeout_ms < PLAYGROUND_LIMITS.timeoutMin || timeout_ms > PLAYGROUND_LIMITS.timeoutMax)
    return {
      ok: false,
      error: `timeout_ms must be ${PLAYGROUND_LIMITS.timeoutMin}-${PLAYGROUND_LIMITS.timeoutMax}`,
    };

  // Session-only key: ephemeral override, never stored server-side.
  let apiKey: string | undefined;
  if (raw.apiKey !== undefined && raw.apiKey !== null && raw.apiKey !== "") {
    if (typeof raw.apiKey !== "string")
      return { ok: false, error: "apiKey must be a string" };
    const k = raw.apiKey.trim();
    if (k.length < 1 || k.length > 500)
      return { ok: false, error: "apiKey too long (max 500 chars)" };
    apiKey = k;
  }

  // Session-only chat URL override: ephemeral, never stored server-side.
  // Shape-checked here (string, <=500 chars); SSRF safety is enforced by
  // assertSafeApiUrl in the route before any fetch happens.
  let chatUrl: string | undefined;
  if (raw.chatUrl !== undefined && raw.chatUrl !== null && raw.chatUrl !== "") {
    if (typeof raw.chatUrl !== "string")
      return { ok: false, error: "chatUrl must be a string" };
    const u = raw.chatUrl.trim();
    if (u.length < 8 || u.length > 500)
      return { ok: false, error: "chatUrl must be 8-500 chars" };
    chatUrl = u;
  }

  const benchmark: BenchmarkDefinition = {
    type: "coding",
    prompt,
    max_tokens,
    timeout_ms,
  };
  if (temperature !== undefined) benchmark.temperature = temperature;
  if (top_p !== undefined) benchmark.top_p = top_p;
  if (system_prompt !== undefined) benchmark.system_prompt = system_prompt;

  return {
    ok: true,
    value: { provider, provider_model_id: modelId, prompt, system_prompt, benchmark, apiKey, chatUrl },
  };
}

/** Truncate streamed preview for API response — in-memory only, never persisted. */
export function truncatePreview(text: string | null | undefined, max = 2000): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}
