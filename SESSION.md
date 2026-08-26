# 2026-08-23 — ModelPulseX Cloudflare observatory initial build

**Approach:**

- Seeded bigpowers conventions (seed-conventions, AGENTS.md/CONVENTIONS.md/specs/*), researched live free models (29 FREE: Zen 9 + OR 20), sliced e01 into 7 stories, built Worker+D1+Queue+Cron+DO, 3 benchmark workloads, scoring, React live dashboard with TokenDyno-inspired sparkline/intelligence, batch files for operable program

**Files changed:**

- `src/*` — providers (zen/or), benchmark engine/scheduler/scoring, db queries, live DO, api routes, types/utils
- `migrations/*` — D1 schema 7-14d raw / 30-90d hourly + indexes
- `frontend/src/*` — dashboard, leaderboard (sparkline+intelligence), charts, hooks
- `wrangler.jsonc, package.json, run.bat/run.sh/deploy.bat, README.md, specs/*`

**Status:** Done (local 16 gates verified, preflight green, live discovery 29, 570 benchmark rows seeded, leaderboard LIVE)
**Next:** Set `wrangler secret put` keys + `wrangler d1 create` → `npm run deploy` to publish; optional third provider via `providers/` interface

## 2026-08-23 (evening) — investigated "dead" deployment URL → fixed recorded URL + SSRF guard

**Investigation:** `modelpulsex.workers.dev` returned NXDOMAIN (internet fine, worker deployed). Root cause: every reference omitted the Cloudflare account subdomain. Real URL: **<https://modelpulsex.vipulgote5.workers.dev>** — verified live (`/` 200 dashboard, `/api/models` 200 ≈58KB). Production was never broken; only the recorded URL was wrong.

**Fixes:**

- Corrected URL in `specs/state.yaml`, `README.md`, `deploy.bat`, `src/benchmark/engine.ts` (HTTP-Referer header)
- `src/benchmark/engine.ts`: new `assertSafeApiUrl()` SSRF shape guard before outbound fetch (https-only, http allowed solely for loopback; rejects credentials/fragment smuggling); `BlockedApiUrlError` maps to `UNKNOWN_ERROR` instead of being misclassified as `STREAM_ERROR`; empty catch on body-read now records `errorType="body_read_failed"` instead of swallowing
- `test/benchmark.test.ts`: +3 guard cases (allow https provider URLs & http loopback; block plaintext-remote/creds/fragment/unparseable; `measureBenchmark` refuses fetch entirely on blocked URL)
- `specs/state.yaml`: handoff summary folded into YAML block scalar (line-length gate)

**Status:** Done — preflight green (29/29 vitest, tsc clean); changes uncommitted on `master`
**Next:** e02/e03 pending (`slice-tasks` not yet run); optional `npm run deploy` to ship the corrected Referer + guard

## 2026-08-23 — prod URL decision: workers.dev endpoint IS official production

**Decision:** Keep `https://modelpulsex.vipulgote5.workers.dev` as THE production URL. Bare `modelpulsex.workers.dev` is technically impossible (`*.workers.dev` always includes the account subdomain; Cloudflare owns all 2-label names). Account has 0 zones, so a custom domain would require registering one (~$10+/yr) — declined for now.

**Verified:** `/api/health` 200 · `/api/leaderboard` 200 on prod · zero stale refs to the old wrong URL repo-wide (SESSION.md history excepted) · `specs/state.yaml` annotated as official prod endpoint with rationale.

**Revisit if:** you register a domain → wire Worker Custom Domain via `routes: [{pattern, custom_domain: true}]` in wrangler.jsonc + redeploy.

## 2026-08-25 — in-depth improvement research → specs/research/IMPROVEMENT_RESEARCH_LATEST.md

**Trigger:** user asked for deep research on how to improve the project further.

**Method:** live-prod API audit (freshness buckets across 152 leaderboard rows, per-provider staleness), codebase review (module complexity via pi-lens, scheduler/engine/routes read-through, test inventory), external landscape research (Artificial Analysis + OpenRouter benchmarks methodology, Cloudflare Queues consumer-concurrency + Analytics Engine docs, cron monitoring patterns, free-tier rate-limit landscape).

**Key findings (full detail + fix plans in specs/research/IMPROVEMENT_RESEARCH_LATEST.md):**

1. 🔴 P0: prod benchmark pipeline STALLED — last_benchmark 03:56Z vs audit 17:48Z (14h), 0 rows fresh <6h, discovery still runs hourly. Suspects: cooldown cascade from exhausted keys, serial queue consumer (~120 jobs/h ceiling vs needed ~450), possible */5 cron misfire. No alerting exists to catch this.
2. 🔴 P0: rankings built on 1–2 samples (`allam-2-7b` #1 with sampleCount24h=2, tps_now 1562.5). Fix: medians + min-sample gates + p50/p90/p99 in aggregates.
3. 🟠 P1: provider registry needs single-descriptor refactor (adding a provider touches 6+ files); hardcoded tokenrouter/ollama cleanups run every discovery (violates own no-hardcode rule); createApi complexity 182; scheduler logic (LRU/RPM/round-robin) has zero tests.
4. 🟡 P2 differentiation: ITL metric, free-tier RPM/RPD awareness, rule-based correctness checks on coding workload, public API docs, OG share cards; ops: CI workflow (remote exists, no CI), real lint gate, Analytics Engine telemetry.

**Files changed:** `specs/research/IMPROVEMENT_RESEARCH_LATEST.md` (new), `SESSION.md` (this entry).

**Status:** Done — research only, no code touched.
**Next:** P0-1 diagnose stall (wrangler tail + DLQ + provider_cooldowns table) → enable queue max_concurrency → staleness watchdog; then P0-2 median/min-sample scoring.

## 2026-08-26 — full fix pass: pipeline revived (root cause found), observability, stats rigor — deployed

**Root cause of recurring benchmark stalls (since Aug 25):** SQLite `datetime('now','-60 seconds')` emits `'YYYY-MM-DD HH:MM:SS'` which string-compares BELOW the ISO-'T' `started_at` column values — so the scheduler's "last 60s RPM window" actually counted all runs since UTC midnight. Cumulative counts crossed per-provider RPM limits every early morning → selectJobs returned zero jobs → daily stall until next midnight reset. Explains the 03:56 Aug 25 stall AND the overnight run/stall cycle after the first fix deploy.

**Fixes shipped (all preflight-green, deployed as e8f79b8e):**

- All window cutoffs switched to JS-computed ISO binds (scheduler RPM window + routes meta/incidents/compare) — pipeline verified LIVE post-deploy (`/api/health?freshness=15` → 200, age_minutes=3)
- Queues consumer `max_concurrency: 8` + parallel-across-provider batch consumption (serial loop was a throughput ceiling)
- Inline fallback: first N jobs (default 6, `BENCH_INLINE_FALLBACK`) execute inside each */5 tick so baseline coverage survives queue-delivery failures
- Scheduler heartbeat persisted per tick + staleness watchdog w/ optional `ALERT_WEBHOOK_URL` (rate-limited hourly); `/api/health?freshness=Nm` probe returns 503 when stale
- Escalating provider cooldowns (quota/429 backoff up to `COOLDOWN_MAX_MS`=2h) honoring Retry-After captured from engine
- Leaderboard medians + min-sample gates (1h≥2, 24h≥3, 7d≥5) + raw-window GROUP_CONCAT percentiles; Methodology page updated
- Provider registry single-descriptor refactor (registry.ts), cached providerFor, capFor map replacing if-chain, one-shot guarded data fixes replacing per-discovery hardcoded cleanups
- CORS origin allowlist (was `*`), empty-catch/error-propagation sweep, `as any` cleanup
- Ops: GitHub Actions CI (lint+test+typecheck), eslint flat-config gate (26 violations fixed, now clean), state.yaml git.remote corrected

**Verification:** 52/52 vitest (+23 new tests: scheduler-select, cooldown escalation, watchdog decisions, concat parsing, retry-after), tsc clean, eslint clean, live smoke: freshness probe 503→200 transition, leaderboard LIVE banner, min-sample gating visible (2-sample model shows null 24h median).

**Pending:** apply migration 0006_scheduler_health.sql remotely (`wrangler d1 migrations apply DB --remote`) once API token has D1 perms (current token = workers-only; heartbeat fields read null via graceful degradation until then). Optional: set `wrangler secret put ALERT_WEBHOOK_URL`.

**Files:** src/* (engine, scheduler, index, routes, registry, health, data-fixes, concurrency, metrics, types, cooldown, queries, providers/index, opencode-zen), frontend/src (Methodology, Dashboard, SummaryCards, Leaderboard, RecommendationCards, ChartModelSelector, CooldownPanel, useLeaderboard), migrations/0006_scheduler_health.sql, test/scheduler-select.test.ts, test/stats-cooldown-health.test.ts, wrangler.jsonc, package.json+lock, eslint.config.js, .github/workflows/ci.yml, README.md, specs/state.yaml.
