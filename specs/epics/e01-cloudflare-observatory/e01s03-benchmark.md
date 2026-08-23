# e01s03 — Real streaming benchmark engine

Status: pending

## Objective
Measure TTFT/TPS from live streaming API responses correctly, across three deterministic workloads, with provider usage vs heuristic token counting and error classification.

## Tasks
- Define benchmark workloads in `src/benchmark/workloads.ts`: short (echo "Hello" -> minimal tokens, latency), medium (summarize 2k tokens -> 200-400 output), coding (Python two-sum + complexity).
- Implement `src/benchmark/engine.ts`: streaming fetch with `AbortSignal.timeout`, record `request_started_at`, `first_token_at` (first chunk after `data: `), `completed_at`, parse `usage.completion_tokens || heuristic`, compute `ttft_ms`, `generation_ms`, `tps`, status enum {SUCCESS,TIMEOUT,RATE_LIMITED,PROVIDER_ERROR,MODEL_UNAVAILABLE,STREAM_ERROR,UNKNOWN_ERROR}, http_status.
- Correct TPS: tokens / (completed - first_token); do not use total duration. Clarify Measured TPS vs Provider TPS in UI flag `token_estimation_method`.
- Handle per-provider streaming shapes (OpenRouter OpenAI SSE, Zen OpenAI SSE, OpenAI compatible).
- Unit tests for calculations, timeout, 429, stream errors.

## Verify
`npm test -- test/benchmark.test.ts`

## Acceptance
- Mock streaming that emits first token at 120ms and completes at 2120ms with 100 tokens → TTFT 120, gen 2000, TPS 50.
- 408/timeout maps to TIMEOUT, 429 to RATE_LIMITED, 404 to MODEL_UNAVAILABLE, invalid SSE to STREAM_ERROR.
