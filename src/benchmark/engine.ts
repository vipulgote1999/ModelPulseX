/** Real streaming benchmark engine — measures TTFT/TPS from SSE chunks. Pure core + small Cloudflare fetch wrapper. */
import type { BenchmarkDefinition, BenchmarkResult, BenchmarkStatus } from "../types";
import { computeGenerationMs, computeTPS, computeTTFT, estimateTokensHeuristic } from "../utils/metrics";

export interface BenchmarkOpts {
  provider: "opencode_zen" | "openrouter";
  providerModelId: string;
  apiUrl: string; // full /v1/chat/completions url
  apiKey: string | undefined;
  benchmark: BenchmarkDefinition;
  extraHeaders?: Record<string, string>;
}

// classify http status into BenchmarkStatus
export function classifyStatus(status: number | null, timedOut: boolean, streamError: boolean): BenchmarkStatus {
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
export async function measureBenchmark(opts: BenchmarkOpts): Promise<BenchmarkResult> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  let firstTokenAtMs: number | null = null;
  let completedAtMs: number | null = null;
  let outputText = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let tokenEstimationMethod: "provider" | "heuristic" = "provider";
  let httpStatus: number | null = null;
  let errorType: string | null = null;
  let timedOut = false;
  let streamError = false;

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
      headers["HTTP-Referer"] = "https://modelpulsex.workers.dev";
      headers["X-Title"] = "ModelPulseX";
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.benchmark.timeout_ms);

  try {
    const res = await fetch(opts.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    httpStatus = res.status;
    if (!res.ok) {
      // read body for error_type when not ok (may not be streaming)
      try {
        const txt = await res.text();
        errorType = txt.slice(0, 500);
      } catch {}
      const status = classifyStatus(httpStatus, false, false);
      clearTimeout(timeout);
      return finalize(startedAtIso, null, null, null, null, status, errorType, httpStatus, opts, tokenEstimationMethod);
    }

    if (!res.body) {
      streamError = true;
      clearTimeout(timeout);
      return finalize(startedAtIso, null, null, null, null, classifyStatus(httpStatus, false, true), "no_body", httpStatus, opts, tokenEstimationMethod);
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
              if (typeof j.usage.prompt_tokens === "number") inputTokens = j.usage.prompt_tokens;
              if (typeof j.usage.completion_tokens === "number") outputTokens = j.usage.completion_tokens;
              if (typeof j.usage.total_tokens === "number" && inputTokens == null) {
                // estimate input if not separately given
              }
            }
            const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.text ?? "";
            if (delta && firstTokenAtMs == null) {
              firstTokenAtMs = Date.now();
            }
            if (typeof delta === "string") outputText += delta;
          } catch {
            // ignore non-JSON data lines
          }
        }
      }
    }
    completedAtMs = Date.now();
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
      outputText, // for internal compute but not persisted
    );
  } catch (e: unknown) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    // AbortError due to timeout already flagged
    if (timedOut || (msg && msg.toLowerCase().includes("abort"))) {
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
): BenchmarkResult {
  const startedMs = new Date(startedAtIso).getTime();
  const firstMs = firstTokenAtIso ? new Date(firstTokenAtIso).getTime() : null;
  const completedMs = completedAtIso ? new Date(completedAtIso).getTime() : null;
  let ttft = computeTTFT(startedMs, firstMs);
  let gen = computeGenerationMs(firstMs, completedMs);
  let tps = computeTPS(outputTokens, gen);
  // Edge: streaming chunk handled in same tick -> TTFT/generation 0 but status SUCCESS -> clamp to minimal measurable
  if (status === "SUCCESS" && firstMs != null && completedMs != null) {
    if (ttft === 0) ttft = 1;
    if (gen === 1 && outputTokens != null && tps == null) tps = computeTPS(outputTokens, 1);
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
    provider: opts.provider,
    model: opts.providerModelId,
    benchmark_type: opts.benchmark.type,
    token_estimation_method: tokenEstimationMethod,
  };
}
