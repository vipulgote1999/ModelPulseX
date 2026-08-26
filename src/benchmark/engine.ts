/** Real streaming benchmark engine — measures TTFT/TPS from SSE chunks. Pure core + small Cloudflare fetch wrapper. */
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  BenchmarkStatus,
} from "../types";
import {
  computeGenerationMs,
  computeTPS,
  computeTTFT,
  estimateTokensHeuristic,
} from "../utils/metrics";
import { retryAfterSeconds } from "../utils/concurrency";

export interface BenchmarkOpts {
  provider: string; // ProviderName (widened for new providers)
  providerModelId: string;
  apiUrl: string; // full /v1/chat/completions url
  apiKey: string | undefined;
  benchmark: BenchmarkDefinition;
  extraHeaders?: Record<string, string>;
}

/**
 * SSRF guard for the outbound provider call. Provider hosts are data owned by
 * the src/providers/* adapters; duplicating the host registry here would
 * create an import cycle (adapters import this module), so we enforce shape:
 * https only, except http on loopback hosts (local dev / self-hosted runtimes),
 * and no credentials or fragments smuggled into the URL.
 */
/** Thrown when the outbound provider URL fails the SSRF shape guard. */
export class BlockedApiUrlError extends Error {}

const LOOPBACK_HOST_RE =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|::1)$/;

export function assertSafeApiUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // unparseable input — normalize into our blocked-url error shape
    throw new BlockedApiUrlError(
      `blocked outbound api url (unparseable): ${rawUrl.slice(0, 200)}`,
    );
  }
  const isLoopback = LOOPBACK_HOST_RE.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new BlockedApiUrlError(
      `blocked outbound api url (protocol/host): ${rawUrl.slice(0, 200)}`,
    );
  }
  if (url.username || url.password || url.hash) {
    throw new BlockedApiUrlError(
      "blocked outbound api url (credentials/fragment)",
    );
  }
}

// classify http status into BenchmarkStatus
export function classifyStatus(
  status: number | null,
  timedOut: boolean,
  streamError: boolean,
): BenchmarkStatus {
  if (timedOut) return "TIMEOUT";
  if (streamError) return "STREAM_ERROR";
  if (status == null) return "UNKNOWN_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status >= 500) return "PROVIDER_ERROR";
  if (status >= 400) return "PROVIDER_ERROR"; // treat 4xx other than above as provider error (bad model)
  return "SUCCESS";
}

// The low-level measure function — uses global fetch so it is testable via mock.
export async function measureBenchmark(
  opts: BenchmarkOpts,
): Promise<BenchmarkResult> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const startedPerf =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : startedAtMs;
  let firstTokenAtMs: number | null = null;
  let firstPerf: number | null = null;
  let completedAtMs: number | null;
  let completedPerf: number | null;
  let outputText = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let tokenEstimationMethod: "provider" | "heuristic" = "provider";
  let httpStatus: number | null = null;
  let errorType: string | null = null;
  let timedOut = false;
  let streamError = false;
  let isReasoning = false;

  const body = {
    model: opts.providerModelId,
    messages: [{ role: "user", content: opts.benchmark.prompt }],
    max_tokens: opts.benchmark.max_tokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(opts.extraHeaders ?? {}),
  };
  if (opts.apiKey) {
    headers.authorization = `Bearer ${opts.apiKey}`;
    // OpenRouter also likes these but optional
    if (opts.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://modelpulsex.vipulgote5.workers.dev";
      headers["X-Title"] = "ModelPulseX";
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.benchmark.timeout_ms);

  try {
    assertSafeApiUrl(opts.apiUrl);
    const res = await fetch(opts.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    httpStatus = res.status;
    if (!res.ok) {
      let retryAfterMs: number | null = null;
      if (httpStatus === 429) {
        // Respect provider Retry-After so cooldowns match reality instead of a fixed guess.
        retryAfterMs = retryAfterSeconds(res) * 1000;
      }
      // read body for error_type when not ok (may not be streaming)
      try {
        const txt = await res.text();
        errorType = txt.slice(0, 500);
      } catch {
        // body unreadable (transport reset before text()) — record why instead of swallowing
        errorType = "body_read_failed";
      }
      const status = classifyStatus(httpStatus, false, false);
      clearTimeout(timeout);
      const out = finalize(
        startedAtIso,
        null,
        null,
        null,
        null,
        status,
        errorType,
        httpStatus,
        opts,
        tokenEstimationMethod,
      );
      if (retryAfterMs != null) out.retry_after_ms = retryAfterMs;
      return out;
    }

    if (!res.body) {
      streamError = true;
      clearTimeout(timeout);
      return finalize(
        startedAtIso,
        null,
        null,
        null,
        null,
        classifyStatus(httpStatus, false, true),
        "no_body",
        httpStatus,
        opts,
        tokenEstimationMethod,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const { value, done: rDone } = await reader.read();
      done = rDone;
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        // process SSE lines
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            done = true;
            break;
          }
          try {
            const j = JSON.parse(data);
            // usage present in final chunk
            if (j.usage) {
              if (typeof j.usage.prompt_tokens === "number")
                inputTokens = j.usage.prompt_tokens;
              if (typeof j.usage.completion_tokens === "number")
                outputTokens = j.usage.completion_tokens;
              if (
                typeof j.usage.total_tokens === "number" &&
                inputTokens == null
              ) {
                // estimate input if not separately given
              }
              // detect reasoning models (OpenRouter reports reasoning_tokens)
              const rt = (j.usage as Record<string, unknown>)
                .completion_tokens_details as
                | Record<string, unknown>
                | undefined;
              const rt2 = (j.usage as Record<string, unknown>)
                .reasoning_tokens as unknown;
              if (
                typeof rt?.reasoning_tokens === "number" &&
                (rt.reasoning_tokens as number) > 0
              )
                isReasoning = true;
              if (typeof rt2 === "number" && (rt2 as number) > 0)
                isReasoning = true;
            }
            const delta =
              j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.text ?? "";
            if (delta && firstTokenAtMs == null) {
              firstTokenAtMs = Date.now();
              firstPerf =
                typeof performance !== "undefined" && performance.now
                  ? performance.now()
                  : Date.now();
            }
            if (typeof delta === "string") outputText += delta;
          } catch {
            // ignore non-JSON data lines
          }
        }
      }
    }
    completedAtMs = Date.now();
    completedPerf =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : completedAtMs;
    // fallback token count if provider didn't return usage
    if (outputTokens == null) {
      const est = estimateTokensHeuristic(outputText);
      if (est != null) {
        outputTokens = est;
        tokenEstimationMethod = "heuristic";
      }
    }
    if (inputTokens == null) {
      const est = estimateTokensHeuristic(opts.benchmark.prompt);
      inputTokens = est;
      if (outputTokens != null && tokenEstimationMethod !== "heuristic") {
        // keep provider for output but note input heuristic — overall method heuristic if output heuristic
      }
    }

    const status: BenchmarkStatus = "SUCCESS";
    clearTimeout(timeout);
    return finalize(
      startedAtIso,
      firstTokenAtMs ? new Date(firstTokenAtMs).toISOString() : null,
      completedAtMs ? new Date(completedAtMs).toISOString() : null,
      inputTokens,
      outputTokens,
      status,
      null,
      httpStatus,
      opts,
      tokenEstimationMethod,
      outputText,
      startedPerf,
      firstPerf,
      completedPerf,
      isReasoning,
    );
  } catch (e: unknown) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    // AbortError due to timeout already flagged
    if (e instanceof BlockedApiUrlError) {
      // SSRF guard rejected the URL before any fetch — not a stream failure;
      // leave timedOut/streamError false so status resolves via null httpStatus.
      errorType = msg.slice(0, 500);
    } else if (timedOut || (msg && msg.toLowerCase().includes("abort"))) {
      timedOut = true;
    } else {
      streamError = true;
      errorType = msg.slice(0, 500);
    }
    const status = classifyStatus(httpStatus, timedOut, streamError);
    // if we already have first_token, preserve it
    return finalize(
      startedAtIso,
      firstTokenAtMs ? new Date(firstTokenAtMs).toISOString() : null,
      null,
      inputTokens,
      outputTokens,
      status,
      errorType ?? msg.slice(0, 500),
      httpStatus,
      opts,
      tokenEstimationMethod,
    );
  }
}

function finalize(
  startedAtIso: string,
  firstTokenAtIso: string | null,
  completedAtIso: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  status: BenchmarkStatus,
  errorType: string | null,
  httpStatus: number | null,
  opts: BenchmarkOpts,
  tokenEstimationMethod: "provider" | "heuristic",
  _outputText?: string,
  startPerf?: number | null,
  firstPerf?: number | null,
  completedPerf?: number | null,
  isReasoning?: boolean,
): BenchmarkResult {
  const startedMs = new Date(startedAtIso).getTime();
  const firstMs = firstTokenAtIso ? new Date(firstTokenAtIso).getTime() : null;
  const completedMs = completedAtIso
    ? new Date(completedAtIso).getTime()
    : null;
  // Use high-res perf if available, else fallback to Date
  let ttft: number | null;
  let gen: number | null;
  if (startPerf != null && firstPerf != null) {
    ttft = Math.round(firstPerf - startPerf);
  } else {
    ttft = computeTTFT(startedMs, firstMs);
  }
  if (firstPerf != null && completedPerf != null) {
    gen = Math.round(completedPerf - firstPerf);
  } else {
    gen = computeGenerationMs(firstMs, completedMs);
  }
  // For reasoning models where provider buffers all tokens, observed gen is ~1ms — clamp to avoid 10k+ TPS inflation
  // Use total duration as fallback for reasoning, else min 20ms clamp
  let genForTps = gen;
  if (isReasoning && gen != null) {
    // reasoning: server thinks before first token, so total = ttft + gen is true wall time
    const total = ttft != null && gen != null ? ttft + gen : null;
    if (total != null && total > 0) genForTps = total;
  }
  if (genForTps != null && genForTps < 20) genForTps = 20;
  let tps = computeTPS(outputTokens, genForTps);
  // Edge: streaming chunk handled in same tick -> TTFT/generation 0 but status SUCCESS -> clamp to minimal measurable
  if (status === "SUCCESS" && firstMs != null && completedMs != null) {
    if (ttft === 0 || ttft === null) ttft = 1;
    if ((gen === 0 || gen === null) && outputTokens != null && tps == null)
      tps = computeTPS(outputTokens, 20);
  }
  // if not SUCCESS, null out ttft/tps
  const ttft_ms = status === "SUCCESS" ? ttft : null;
  const generation_ms = status === "SUCCESS" ? gen : null;
  const tpsVal = status === "SUCCESS" ? tps : null;
  return {
    request_started_at: startedAtIso,
    first_token_at: firstTokenAtIso,
    request_completed_at: completedAtIso,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ttft_ms: ttft_ms,
    generation_ms,
    tps: tpsVal,
    status,
    error_type: errorType,
    http_status: httpStatus,
    provider: opts.provider as import("../types").ProviderName,
    model: opts.providerModelId,
    benchmark_type: opts.benchmark.type,
    token_estimation_method: tokenEstimationMethod,
  };
}
