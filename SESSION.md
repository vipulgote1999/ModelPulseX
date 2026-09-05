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

## 2026-08-26 (later) — migration 0006 applied remotely after token perms granted

`wrangler d1 migrations apply DB --remote` → all 6 migrations ✅. Heartbeat verified live on next */5 tick: last_enqueue_count=10 (queue delivery fine — it was only ever starved by the RPM-window bug), inline=6, skipped_cooldown=34, skipped_rpm=0, pipeline fresh. Observability loop complete.

## 2026-09-05 — landing video review + timeout-history graph

Playwright video/screenshot tour of prod landing found the 7-day TPS chart rendering empty (defaults were top-3 by static Intelligence score — models with no TPS history). Fixed + deployed:

- Dashboard defaults to top-3 by measured overall_score; new "BEST MODEL RIGHT NOW" hero strip; rec cards 6→4 (dropped mislabeled BEST CODING + dup CONSISTENCY); CooldownPanel collapsed by default with reason truncation.
- New `GET /api/timeouts?range=` (no migration — aggregates raw benchmark_runs): stacked daily/hourly refusal bars by provider + per-provider refusal cards (limited/timeouts/other + % of its runs) + most-refused models. Lazy-loaded `TimeoutChart` after ReliabilityChart. Live: 3058 refusals / 8982 runs; nscale 100%, nvidia 60.7% stand out.
- Wired context-mode MCP (`ctx` server in ~/.pi/agent/mcp.json, verified handshake) — needs pi restart to load ctx_* tools.

**Verification:** 68/68 vitest (+2 timeouts foldProviders, +parity entry), tsc/eslint clean, Playwright re-capture confirms hero + populated TPS + timeout graphs, no page errors.

**Files:** src/api/timeouts.ts (new), src/api/routes.ts, test/timeouts.test.ts (new), test/routes-parity.test.ts, frontend/src/charts/TimeoutChart.tsx (new), frontend/src/pages/Dashboard.tsx, ChartModelSelector.tsx, CooldownPanel.tsx, RecommendationCards.tsx, scripts/capture-landing.mjs + capture-sections.mjs (new), package.json (playwright devDep).

## 2026-09-05 (later) — record→review→fix loop round 3

Round-3 Playwright tour found: (1) diffusion ~11k TPS outlier flattened all other lines on the TPS chart; (2) "unknown" free-tier pill under nearly every leaderboard row (only 5/19 providers have limit data); (3) Intelligence column "—" for ~85% of rows (16 AA-mapped IDs of 106 models). Fixed + deployed:

- TpsChart log/linear toggle, auto-log when max/min > 10x (Y-axis now 50–10k readable, all 3 lines comparable).
- Limit badge renders only with real data (limits or 24h usage), no "unknown" noise.
- Intelligence column conditionally renders only when a row has an AA score; also removed two redundant `as unknown` casts (Row type already optional) + SAFETY comments on remaining sort assertions.
- lens-gate: 5-blocker finding set reviewed — markdown-spacer items skipped with rationale (cosmetic, stable); SAFETY-comment items fixed.

**Verification:** 68/68 vitest, tsc/eslint clean, deployed, screenshots confirm log-scale TPS + clean provider cells, no page errors.

## 2026-09-05 (later) — continuous improvement: table fit, backend batching, commits secured

- Leaderboard overflow measured per-column per-width (Playwright JS): hid Trend/Last-Test below 2xl/xl, 1h/24h/Intelligence below xl, truncated model names, shortened usage pill, relative timestamps, wrapped status badges. Overflow: 1440/1280/1024 = 0px (was 162/282/~100).
- Backend: db.batch single round-trips for /api/compare (4 queries) and /api/models/:id/incidents (4); edge-cache on providers/cooldowns/compare/timeouts; scheduler SELECT id existence check; parallel incident streak/open reads; dropped dead foldProviders helper + test.
- Secured 4 conventional commits on master (feat timeouts, feat dashboard, fix table, perf backend). Gate green throughout (66 tests, tsc, eslint, secret-scan).

## 2026-09-05 (later) — timeout cards name the dominant reason; empty-completion fix shipped

- TimeoutChart provider cards now show "mostly STATUS (n)" when other-errors dominate (frontend-only, derived from the failures array — no backend change). Live proof: nscale's 100% refusals are PROVIDER_ERROR, not rate limits.
- fix(bench) 6ff6a80: finalize() downgrades 200/zero-token SUCCESS to STREAM_ERROR; hero 7d fallback.
- docs(methodology) 5629809: empty-completion rule + /api/timeouts listing.

## 2026-09-05 (later) — docs code-block newlines + openapi timeouts

- JSX condenses literal <pre> newlines into spaces: Docs quickstart and Methodology formula/API blocks rendered as horizontal blobs. Rebuilt as template strings (verified 5/2/13 lines live) + /api/timeouts added to OpenAPI spec and its route-coverage test.

## 2026-09-05 (later) — continuous loop: DO fixes, dead-code purge, docs sync

- fix(live) c6b44b6: DO sessions Set→Map with drop() (ipCounts no longer leak on dead connections); idle alarm stops rescheduling; ACAO echo uses the same allow-set as the gate (127.0.0.1:8787 + CORS_ORIGIN were gated-OK but stream-blocked). +5 DO tests (72 total).
- chore(security) aeefd8f: -122 lines dead validators/helpers nobody imports.
- fix(scheduler) 846f8ec: isFinite guard on fallback inline count; perf(discovery) 8d94807: per-provider upserts concurrent.
- fix(docs) b85e10d: JSX <pre> newline collapse fixed via template strings; /api/timeouts in OpenAPI + test; README synced.

## 2026-09-05 (later) — groq allowlist cross-checked, left intact

- Audited VERIFIED_FREE (NEVER-rule tension: hardcoded free list). Verdict: keep — Groq models API exposes no pricing, mistral/cerebras adapters are looser (mark-all-FREE), and live discovery returns 6 groq models all inside the set. Pipeline self-heals via Previously Free on churn. Refreshed the verification comment with today's evidence instead of refactoring.
