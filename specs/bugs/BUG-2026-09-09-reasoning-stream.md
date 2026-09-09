# BUG-2026-09-09T000000: Streaming parser ignores reasoning deltas — reasoning models mismeasured / timeout

## Problem

- Actual: `measureBenchmark` in the shared streaming engine only reads
  `choices[0].delta.content` (fallback `delta.text`). All reasoning delta
  shapes (`reasoning_content`, `reasoning`, `thinking`,
  `reasoning_details[]`) are silently dropped.
- Consequences for thinking models (Zen `mimo-v2.5-free`,
  `muse-spark-1.3-contributor-free`, `deepseek-v4-flash-free`, OpenRouter
  reasoning models):
  1. TTFT is measured to first *visible* token, so the full hidden/exposed
     reasoning phase inflates TTFT (correct direction, but unbounded).
  2. `output_tokens` uses `usage.completion_tokens` verbatim, which
     *includes* reasoning tokens on reasoning models → TPS inflated
     (more tokens / same generation window).
  3. Reasoning-only activity never marks stream liveness: a stream that
     emits 20s of `reasoning_content` then answers looks idle until the
     first content chunk; the `empty_completion` guard cannot distinguish
     "no tokens at all" from "reasoning but no answer".
  4. `isReasoning` detection only checks two `usage` shapes, so Zen
     passthrough (`reasoning_content` with no usage detail) is never
     flagged and skips the reasoning TPS fallback.
- Expected: provider-normalized parser that accumulates `content`
  separately from all known reasoning shapes, subtracts reasoning tokens
  from `output_tokens` when reported, flags `isReasoning` on any reasoning
  signal, and distinguishes `reasoning_no_content` from
  `empty_completion_no_tokens`.

Reproduce (unit, no credits): mock `fetch` SSE with
`delta: { reasoning_content: "let me think..." }` × N then
`delta: { content: "PONG" }` + `usage: { completion_tokens: 100,
completion_tokens_details: { reasoning_tokens: 90 } }`.
Before fix: TTFT fires only on PONG, `output_tokens` = 100 (should be 10),
`isReasoning` depends on usage shape only.

Security impact: NONE — measurement-only path, no auth/SSRF change. No
security exploit path identified.

## Root Cause Analysis

- Code path: all 19 provider adapters call shared
  `measureBenchmark` (benchmark engine module). The SSE loop extracts one
  field (`delta.content ?? delta.text`) and appends it to `outputText`.
- Why it fails: OpenAI-compatible reasoning providers multiplex thinking
  onto parallel delta fields. DeepSeek/Mimo-via-Zen use
  `delta.reasoning_content` (string); OpenRouter normalizes to
  `delta.reasoning` (string) plus structured
  `delta.reasoning_details[]` (`{type:"reasoning.text",text}` /
  `{type:"reasoning.summary",summary}`); some gateways use
  `delta.thinking`. None of these hit the `content` extractor, so they
  contribute zero chunk timestamps, zero text, zero liveness.
- Contributing factors:
  - Short workload `timeout_ms: 15000` vs hidden-reasoning models
    (Muse Spark keeps reasoning private — long silence, then burst).
    Parser fix does not shorten thinking; it only stops misattribution.
  - DeepSeek-documented mid-`reasoning_content` SSE stalls (no `[DONE]`,
    connection open) surface as TIMEOUT in our engine, which is
    wall-clock-correct but hides the stall cause.
  - `finalize` reasoning TPS fallback (total-duration + 20ms clamp) never
    triggers for Zen because `isReasoning` stays false.
- Risk level: Medium. Shared choke point — one fix covers all providers;
  token-math change alters stored TPS for reasoning models only
  (non-reasoning streams byte-identical).

## TDD Fix Plan

1. **RED**: reasoning_content chunks do not count as answer text but mark
   reasoning; content TTFT/TPS still measured on visible tokens.
   **GREEN**: extract `reasoning_content|reasoning|thinking` strings +
   `reasoning_details[].text|summary` in SSE loop into a separate
   reasoning accumulator; never append to `outputText`/`chunkTimes`.
   **verify**: `npx vitest run test/benchmark.test.ts`
2. **RED**: `usage.completion_tokens=100` with
   `completion_tokens_details.reasoning_tokens=90` stores
   `output_tokens=10`; `usage.reasoning_tokens=90` shape also works.
   **GREEN**: subtract known reasoning tokens from completion tokens
   (floor 0); set `isReasoning` on any reasoning delta OR usage signal.
   **verify**: `npx vitest run test/benchmark.test.ts`
3. **RED**: stream with only reasoning deltas + `[DONE]` yields
   `STREAM_ERROR/reasoning_no_content`, not `empty_completion_no_tokens`.
   **GREEN**: split the empty-completion guard on reasoning-seen flag.
   **verify**: `npx vitest run test/benchmark.test.ts`
4. **RED**: OpenRouter `delta.reasoning_details=[{type:"reasoning.text",
   text:"..."}]` marks reasoning without polluting answer text.
   **GREEN**: covered by cycle 1 extractor (array branch).
   **verify**: `npx vitest run test/benchmark.test.ts`

**REFACTOR**: keep extractor a small pure helper next to the engine core
(no new modules, no schema change — existing `BenchmarkResult` columns
unchanged).

## Acceptance Criteria

- [ ] Reasoning deltas never inflate `outputText`, `chunkTimes`, or TPS
- [ ] `output_tokens` excludes reported reasoning tokens when available
- [ ] `isReasoning` true on any reasoning delta or usage reasoning signal
- [ ] Reasoning-only streams report `reasoning_no_content`
- [ ] Non-reasoning streams byte-identical (existing tests green)
- [ ] `npm test && npm run typecheck` green

## Resolution

Fixed 2026-09-09 on `fix/reasoning-stream` (commits `test(bench):
reasoning-stream RED cases` + `fix(bench): normalize reasoning deltas in
stream parser`). `measureBenchmark` now extracts `reasoning_content` /
`reasoning` / `thinking` / `reasoning_details[].text|summary` into a
separate accumulator, subtracts reported reasoning tokens from
`output_tokens`, flags `isReasoning` on any reasoning signal, and reports
`reasoning_no_content` for reasoning-only streams. Preflight green:
97 tests (94 existing + 3 new), `tsc --noEmit` clean, eslint clean on
touched files. Note: hidden-reasoning models (Muse Spark keeps thinking
private — silence then burst) still carry thinking time inside TTFT by
 design; the 15s short-workload timeout can legitimately fire on slow
reasoning runs — that is honest measurement, not a parser stall.

Live verification 2026-09-09 (local D1 + dashboard on :8788): wiped mock
`a/b/c:free` seed rows, ran real discovery (148 models incl.
`mimo-v2.5-free`, `muse-spark-1.3-contributor-free`), queued short
benchmarks. Raw Zen SSE for mimo shows `reasoning` + `reasoning_details`
deltas with empty content and `finish_reason:length` at max_tokens=16 —
confirming both the guard fix and the short-budget raise to 64. Post-fix
run 18: SUCCESS, TTFT 3009ms (thinking time), TPS 9.9 via total-duration
fallback, visible in UI as rank #1. muse-spark-1.3 returns HTTP 500
upstream (provider-side); engine correctly stores PROVIDER_ERROR.
