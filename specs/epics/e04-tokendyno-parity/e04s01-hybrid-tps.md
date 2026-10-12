# e04s01 — Hybrid TPS + fresh-session anti-cache + speed-probe workload

Source: TokenDyno methodology (2026-10-12) + FAQ JSON-LD + overview API.

## TokenDyno observed behavior (evidence)

- One run = single streaming request, fixed prompt ("write a 400-word prose
  explanation of HTTP request routing"), output capped at **300 tokens**
  including reasoning where the provider counts it.
- Muse Spark Contributor models run with `reasoning.effort: minimal`; hidden
  reasoning shares the 300-token budget; TPS counts visible text only.
- **Fresh session every run**: single message, no history; where a gateway keys
  conversations by a session header (OpenCode gateways since Sep 2026), each
  request carries a newly generated identifier. Defeats session-keyed cache,
  not body-keyed cache (disclosed as limitation).
- **TTFT** = dispatch → first non-empty content chunk (network + prefill).
- **TPS hybrid**: inter-token timing when response streams smoothly (**>= 8
  chunks with mean gap > 50ms**); wall-clock fallback
  (`output_tokens / generation_time`) for burst/chunked delivery where
  inter-token gaps are meaningless. TTFT excluded in both paths.
- Cadence varies by tier (spend control, never affects measurement):
  Ollama Pro ~10m, Ollama Free ~60m, Zen ~60m, Go standard ~30m / priciest ~6h.
- Overview API row: `latestTps, latestTtftMs, lastTestedAt, avgTps24h,
  successRate24h, sampleCount24h, sparkline[24], thinkingCapable,
  aaIntelligence, aaUrl, aaReasoningModel`.

## What changes in ModelPulseX (this story)

1. **Hybrid TPS pure logic** (`src/utils/metrics.ts`):
   - `computeHybridTps({ outputTokens, generationMs, chunkGapsMs }): { tps, method }`
   - inter-token path iff `chunkGapsMs.length >= 7` (>= 8 chunks) AND mean > 50ms:
     `tps = 1000 / mean_gap` (tokens/sec from mean inter-token gap).
     Else wall-clock: existing `computeTPS(outputTokens, generationMs)`.
   - Method type `TpsMethod = 'inter-token' | 'wall-clock' | null`.
   - Null rules preserved: null tokens/gen → null (no fabrication).
2. **Engine wiring** (`src/benchmark/engine.ts` `finalize`):
   - Derive per-chunk gaps from captured `chunkTimesMs` (already bounded to
     512 samples) and call `computeHybridTps`.
   - Persist method on result as optional `tps_method` (ephemeral field,
     stored by migration 0016).
   - TTFT definition unchanged (already dispatch → first content chunk) —
     document parity in methodology.
3. **Fresh-session anti-cache** (engine):
   - Every run generates `sessionId = crypto.randomUUID()` (fallback randomHex)
     and sends `x-benchmark-session: <id>` + `x-opencode-session: ses_<hex>`
     when caller did not supply them (Zen keeps its own UA + headers).
   - Body stays single-turn (no history) — already true; add regression test.
   - Disclose body-keyed-cache limitation in methodology (same as TokenDyno).
4. **Speed-probe workload** (`src/benchmark/workloads.ts`, `src/types.ts`):
   - New `BenchmarkType 'speed'`: TokenDyno-identical prompt + `max_tokens: 300`,
     `timeout_ms: 60000`, `top_p: 0.95` (same sampling as coding).
   - `BenchmarkType = 'coding' | 'speed'`; DB CHECK constraints widened via
     migration 0016 (benchmark_runs + hourly/tenmin stats use CHECK IN
     ('short','medium','coding') in older migrations — verify and widen).
   - Scheduler cadence for speed probes lands in e04s02 (tiered cadence);
     this story only adds the definition + engine `reasoning.effort: minimal`
     for muse-spark models (provider-agnostic: if model id contains
     'muse-spark', set `body.reasoning = { effort: 'minimal' }`).
5. **Migration 0016** (`migrations/0016_tokendyno_parity.sql`):
   - `ALTER TABLE benchmark_runs ADD COLUMN tps_method TEXT CHECK (...)`.
   - Widen benchmark_type CHECKs to include 'speed' (SQLite: recreate via
     table rebuild only where CHECK exists — benchmark_runs, hourly_model_stats,
     tenmin_model_stats if present).
   - Seed `benchmark.speed.prompt` config + `methodology.hybrid_tps` note.
   - Reversible:romes down-migration documented in file header (DROP COLUMN
     not supported → down = no-op comment + workload seed delete).

## Test plan (TDD)

- `test/metrics.test.ts`: hybrid picks inter-token when >= 7 gaps mean > 50;
  falls back when < 8 chunks, mean <= 50, empty gaps, null inputs.
- `test/benchmark.test.ts`: engine result carries `tps_method`;
  fresh-session headers present + unique per run; muse-spark body has
  reasoning.effort minimal; single-message body (no history).
- `test/workloads.test.ts`: speed workload prompt/cap/timeout exact.

## Rollback

Each commit is independently revertible (`git revert <sha>`); migration 0016
is additive (new nullable column + seeds) — safe to leave applied on revert.
