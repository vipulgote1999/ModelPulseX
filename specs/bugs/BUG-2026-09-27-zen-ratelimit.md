# BUG-2026-09-27 — Zen daily 429 truncated to 1h + burst re-hit

**Severity:** high · **Priority:** high · **Scope:** `src/utils/concurrency.ts`, `src/benchmark/scheduler.ts`, `src/index.ts`, `src/api/admin/playground.ts`, `wrangler.jsonc`, `src/types.ts`

## Symptom

Playground export 2026-09-27T06:34Z: `opencode_zen/space-bunny-free` →
`429 FreeUsageLimitError`, response header `retry-after: 62733` (~17.4h,
daily reset) but persisted `retry_after_ms: 3600000` (1h). Next `*/5` tick
re-fires while the provider is still limited, burning quota + inserting
repeated `RATE_LIMITED` rows.

## Root cause

1. `retryAfterSeconds()` in `src/utils/concurrency.ts:154` caps at
   `min(3600, secs)`. `62733 → 3600`. `rateLimitCapMs()` in
   `src/db/cooldown.ts:115` would honor the full value, but never sees it.
2. Burst: `MAX_OPENCODE_CONCURRENCY=3` (`wrangler.jsonc:33`, default
   `src/utils/concurrency.ts:55`) + `RPM_OPENCODE_ZEN=5`
   (`src/utils/concurrency.ts:82`) + `inlineTake=6` + queue
   `max_concurrency:8/max_batch_size:10` + `sendBatch`/`retry()` with no
   `delaySeconds` (`src/benchmark/scheduler.ts:270`,
   `src/index.ts:208`). Zen free quota is account-wide daily, not
   per-model per-minute — 3 concurrent streams trip it.
3. Playground shares the same key as cron and fires even while the
   provider is cooling (`src/api/admin/playground.ts:124` has no
   `isProviderCooling()` gate).

## Fix (minimum)

1. Honor upstream reset: cap `retryAfterSeconds()` at `86400` (24h =
   Queues `delaySeconds` max), not `3600`. Covers Zen `62733s` daily reset.
2. Serialize Zen: `MAX_OPENCODE_CONCURRENCY 3→1`,
   `RPM_OPENCODE_ZEN 5→2` (defaults + `wrangler.jsonc` vars). One Zen job
   per wave, no concurrent streams.
3. Queue-native pacing (Cloudflare docs `queues/configuration/batching-retries`):
   - `sendBatch(..., {delaySeconds: batchIndex*60})` staggers waves over
     the 5-min tick instead of firing all at once.
   - `msg.retry({delaySeconds: backoff(attempts)})` exponential
     `60*2^attempts` capped `86400` instead of immediate retry.
   - Pure helpers in `src/utils/concurrency.ts` so logic stays
     Cloudflare-free + unit-tested per CONVENTIONS.
4. Playground gate: `isProviderCooling()` before `measureBenchmark()`;
   return `429 { cooling, cooldown_until }` while cooling.

## Out of scope

- Workers Rate Limit binding (`ratelimits`) — needs new binding + config;
  revisit if 1-4 insufficient.
- DO token-bucket coordinator — same, larger change.
- Per-provider daily RPD budget table — `provider_cooldowns` escalation
  already covers it once (1) lands.

## Verification

- [x] New unit tests: `62733` parses fully; staggered delays
      `0,60,120…`; retry backoff `60,120,240…` capped `86400`.
- [x] Updated: `queue-do.test.ts` default `maxOpencode 3→1`.
- [x] `node node_modules/typescript/bin/tsc --noEmit` (preflight; npm
      scripts broken on this mount — `.bin` only has `.cmd`)
- [x] `node node_modules/vitest/dist/cli.js run` 182+ tests green
- [x] `node node_modules/eslint/bin/eslint.js .` green
- [x] `vite build` then `wrangler deploy`, prod smoke:
      `/api/health` 200, `Retry-After: 62733` shape replays to ≥17h
      cooldown (unit-level; no live 429 burn).
