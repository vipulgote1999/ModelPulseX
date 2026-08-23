# ModelPulseX — Conventions

Read this before any git operation or code change.

## Project
Cloudflare-native LLM Performance Observatory benchmarking FREE models (OpenCode Zen + OpenRouter) with streaming TTFT/TPS measurement, 7-day retention, live SSE leaderboard.

Stack: TypeScript / Cloudflare Workers + D1 + Durable Objects (SQLite) + Queues + Cron / React Vite Tailwind shadcn Recharts / Vitest, wrangler

## Commands
| Action | Command |
|--------|---------|
| Run (dev) | `npm run dev` |
| Test | `npm test` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Lint | `npm run lint` (eslint/biome if present) |
| Preflight | `npm test && npm run typecheck` |
| Deploy | `npm run deploy` |
| Migrate | `npm run migrate` |

## Architecture
`src/providers/` (LLMProvider interface + adapters) → `src/benchmark/` (engine,scheduler,scoring) → `src/db/` (D1 queries, aggregation, retention) → `src/live/` (Durable Object SSE) → `src/api/` (REST) ; `frontend/src/` (pages,components,charts,hooks). Migrations in `migrations/`.

## Conventions
- Pure logic (windows, scoring, TPS/TTFT, free detection, model discovery, adapters) lives without Cloudflare imports and MUST be unit-tested.
- All benchmark state lives in D1 + Durable Object; never in KV or worker globals.
- Providers are data + behavior in src/providers; engine only consumes LLMProvider.
- Tests: Vitest, test/*.test.ts, run with npm test; mock provider APIs, never consume real credits in tests.
- Specs are YAML-first: specs/state.yaml, specs/release-plan.yaml, specs/epics/*; specs/ is memory.
- Only store necessary data: raw 7-14d, hourly 30-90d, aggregates indefinite; no response bodies.
- HTTP uses UTC internally, display converts to user tz; TTFT = first_token - started; TPS = output_tokens / (completed - first_token).

## Defensive code categories (all core to this project)
- **Rate limit**: global/provider/model concurrency caps, provider-specific RPM/RPD respected, Queue batching.
- **Retry**: exponential backoff + jitter, provider circuit breakers, respect 429 Retry-After.
- **Circuit breaker**: per-provider Durable/DB cooldown timers; skip while cooling.
- **Timeout**: upstream fetch aborts via AbortSignal.timeout; benchmark jobs short and retryable.
- **Graceful degradation**: cost-protection verifyFree gate; fallback to last-known result with "Previously Free"; stale-data banners when fresh data lags.

## Always Green / Shift Left
- 1:10:100 rule: fix earliest is cheapest. Preflight catches defects at 1x, not 100x in prod.
- Preflight = npm test && npm run typecheck (and lint if configured) — must be green before commit/merge.
- CI = wrangler deploy checks + D1 migration validation + provider adapter mock tests.
- If Preflight is red, STOP: quick-fix for trivial data-only, else investigate-bug → develop-tdd → validate-fix.

## Discovered Defects
Reproducible failures found while working on something else: fix-or-log.
Trivial data-only fixes go through quick-fix; logic fixes go through investigate-bug → develop-tdd → validate-fix. Separate commits for discovered fixes.

Banned dismissive phrases: "pre-existing", "unrelated to session", "not introduced by my changes", "out of scope" (when ignoring a red gate).

## Never
- Never hardcode API keys or secrets in source, wrangler.jsonc, or specs.
- Never hardcode free-model lists; discover dynamically and skip UNKNOWN pricing.
- Never benchmark paid/unknown models — verifyFree() before queueing.
- Never fabricate data; surface observed-data window honestly.
- Never use total duration for TPS; MUST use generation_time = completed_at - first_token_at.
- Never dismiss reproducible gate failures as pre-existing or out of scope.
- Never proceed on red Preflight — invoke quick-fix or fix-bug first.
- Never add a provider without limits, adapter, discovery, and dashboard row.
- Never store response bodies unless explicitly flagged for debugging (and then TTL-short).

## Stack Conventions
- TypeScript strict, ESM, nodejs_compat in Workers.
- D1 via wrangler d1; migrations timestamped SQL in migrations/.
- Durable Objects SQLite; Queues for benchmark jobs; Cron for scheduler + aggregation + cleanup.
- Frontend: Tailwind + shadcn/ui, Recharts or ECharts, SSE live updates via EventSource.
- Secrets via wrangler secret put (OPENCODE_API_KEY, OPENROUTER_API_KEY, ADMIN_TOKEN) — never in bundle/D1/logs.

## Git
- Conventional Commits: feat:, fix:, refactor:, docs:, chore:, test:, perf:
- workflow_mode: solo-git (see specs/state.yaml). Land via release-branch solo-local when epic completes.
