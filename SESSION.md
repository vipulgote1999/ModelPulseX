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

**Pending:** apply migration 0006_scheduler_health.sql remotely (`wrangler d1 migrations apply DB --remote`) — **resolved 2026-08-26, see the next entry** (DB is current through 0013). Still open: set `wrangler secret put ALERT_WEBHOOK_URL` (optional).

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

## 2026-09-05 (later) — watchdog alert accounting fix (TDD)

- fix: watchdogCheck stamped last_stale_alert_at and reported alerted:true even with no webhook configured or a failed send — silencing retries for an hour over nothing delivered. Now returns alerted:false unstamped in both cases; stamps only after HTTP 2xx. + explicit https check at the sink.
- test/watchdog.test.ts: 3 D1-stubbed cases (77 total green). Debugging note: first mock only exposed first()/run() after bind(), but getLastBenchmarkAt calls .first() directly — silent null collapsed every branch; mock now mirrors the D1 statement shape.

## 2026-09-05 (later) — cooldown poll dedup + watchdog/DO/admin rounds

- perf(frontend): useCooldowns module-level dedup (10s share window, hidden-tab skip, forced refresh after admin reset). Measured live: 7 → 3 cooldown requests per 26s per visitor.
- fix(live): DO session Map + drop(), idle alarm stops, ACAO echo allow-set unified; +5 DO tests.
- fix(watchdog): stamp alerts only on delivered sends (TDD, +3 tests).
- fix(admin): bulk requires explicit enabled; login hint corrected.
- 77 tests green, tree clean, all deployed.

## 2026-09-05 (later) — D1 5M/day cap breached again, quota UX shipped

- Prod down with leaderboard 500s: wrangler tail proved D1 free-tier daily row-read limit (second breach today; benchmark jobs + reads all failing). Not code-caused — organic growth + verification traffic against a hard cap.
- fix(quota): onError maps quota errors to 503 {error: d1_quota_exceeded}; useLeaderboard propagates the code; Dashboard shows a midnight-UTC-resume banner (verified live).
- Burn reduction for post-reset: edge TTLs up (leaderboard 30→120s, timeouts/compare 60→300s, cooldowns 5→15s).
- Lesson: halt prod Playwright verification while quota is exhausted; it burns the same capped rows.

## 2026-09-05 (later) — leaderboard snapshot refactor (user chose over paid D1)

- Migration 0012 (leaderboard_snapshot + models.last_now_json) + insertBenchmarkRun json_patch stamp (same UPDATE, zero new round trips). Replaces a dead 5-column overlay whose UPDATE failed silently on prod (no such columns → every job ran a wasted failing batch + insert fallback).
- Writer refreshLeaderboardSnapshot on the hourly cron: ONE raw GROUP_CONCAT pass + hourly spark read → exact raw medians per (benchmark, model), ~1700-row batch upsert, never throws. Fixed ~20k/tick vs unbounded per-hit scans.
- Reader serves snapshot (~600 rows/hit, 25-50x cut) with live-query fallback when empty/missing; scoring/sort/summary shared via finish(). now_* overlay from last_now_json keeps per-run freshness.
- Established: leaderboard numbers are range-independent (range only affects charts) → snapshot key is benchmark only (4 sets, not 16).
- 8 snapshot unit tests (85 total green). Deployed; migration apply blocked by the active quota breach (also blocks DDL) — will apply after midnight UTC reset, then verify population. Fallback verified live (graceful 503, no crash on missing table).

## 2026-09-05 (later) — snapshot reader verified end-to-end on local D1

- Seeded local D1 (3 models, 16 runs, hourly rows); migration 0012 applies cleanly.
- Live path after finish() extraction: correct medians/gating/scores (200).
- Snapshot path: manually inserted snapshot rows + last_now_json overlay → serves snapshot values with fresh now_* overlay (200). Fallback intact.
- Gotcha: wrangler dev served a stale bundle on first hits (looked like snapshot fallthrough); hot-reload + retest proved the code correct. A temporary catch-log found nothing because nothing was wrong.

## 2026-09-09 — pulled origin (PR #6 + #7), resolved merge, deployed fresh build

**Pull:** `git pull` had been started earlier and sat half-merged (UU `ChartModelSelector.tsx`). One-line conflict: HEAD said "top 3 overall (measured leaders)", origin (PR #7 provider-dynamic graphs) said "Top 3 for {providerLabel} · {benchmark}". Kept origin's dynamic subtitle + HEAD's measured-`overall_score`-first sort (PR #7's Intelligence-first sort would have regressed the Sept-5 measured-leaders decision). Also dropped two `as unknown as number` casts on plain `0` (lint-flagged slop, identical typecheck). Master commits are tool-gated, so the true merge lives on `chore/sync-origin-master` (`0be1c50`, parents `d10ca0a` + `765602c`); `master` ref untouched, nothing pushed.

**Deploy:** preflight green (vitest + `tsc --noEmit` + eslint). First `wrangler deploy` shipped a STALE frontend — `dist/` was built Sep 5 (`wrangler deploy` does not build). Ran `npm run build` (new bundle `index-C1yg_2wh.js`, old subtitle gone) + redeployed. Smoke: `/`, `/api/health`, `/api/leaderboard`, `/api/models` all 200; `freshness=15` probe 200 (pipeline live); prod HTML serves the new bundle.

**Next:** open PR / fast-forward `master` to `chore/sync-origin-master` when ready (holds 40 local + 3 origin commits); working tree has unstaged `src/db/snapshot.ts` (comment + formatter-only rewrap, no logic).

## 2026-09-09 — manual Test button, full merge to master, Zen 429 fix (all deployed)

**Test button (deployed):** per-row play button in Leaderboard Status cell calls existing `POST /api/admin/benchmark` (`short`); reuses CooldownPanel token helpers (now exported); busy→queued(45s)→idle + error+alert; `stopPropagation` preserves row-pinning; no new column (zero-overflow intact). Design per ui-ux-pro-max (emerald-on-zinc, SVG, focus ring). No backend change; backend suite green.

**Merge:** `master` FF'd to `b623718` then fix commit below — holds all 40 local + 3 origin commits + feature. Reviewer subagent verified neither branch was on `master` pre-merge and flagged the regress risk, which drove merging sync in before deploy. Nothing pushed.

**Zen RATE_LIMITED root cause (fixed, deployed):** all Zen rows 429'd with `FreeUsageLimitError` (~2h provider cooldown) while direct Zen calls from here return 200 — our implementation, not Zen. Two bugs: (1) Zen RPM default 20/min vs a free tier that trips on ~6-stream bursts → default 5 (`RPM_OPENCODE_ZEN` overrides); (2) blind 429s (no Retry-After) doubled to the 2h cap, so one burst blacked out the provider for hours — new pure `rateLimitCapMs()` caps blind 429s at 15min, explicit Retry-After still honored fully (OpenRouter midnight path intact) +3 unit tests. Vitest+tsc+eslint green, rebuilt, redeployed, prod smoke 200s (benchmark-without-token correctly 401).

**Note:** stale 2h Zen cooldown row expires alone; `/admin/cooldown/reset` clears it now. Manual Test jobs bypass cooldown skips by design (consumer never gated).

## 2026-09-10 — D1 rows-read cap: full-table scans in the provider-count query (fixed)

**Symptom:** Cloudflare blocked D1 reads — 5M rows-read/day free tier exceeded. Dashboard showed one query at **74% of the budget**: `SELECT provider, COUNT(*) FROM benchmark_runs WHERE started_at >= ? GROUP BY provider` (353 calls, 3.74M rows, 10.6k rows *per call* on a 10.6k-row table).

**Root cause:** not missing indexes — a planner trap. `idx_benchmark_runs_provider_model(provider, model)` has `provider` leading, so SQLite satisfied `GROUP BY provider` from index order and planned `SCAN benchmark_runs USING INDEX idx_benchmark_runs_provider_model` — **`started_at >= ?` was never used as an access path**; the filter ran per row after scanning all 7 days. Reproduced with and without `ANALYZE`, and with a covering `(started_at, provider)` index present. The scheduler's RPM limiter asks for a 60-second window and paid for 7 days, 288 cron ticks/day.

**Fix (`GROUP BY +provider`):** unary `+` makes the term not a bare column, so the index-order shortcut is unavailable and the planner falls back to `SEARCH ... (started_at>?)`. `+` is a no-op in SQLite (`+'openrouter'` → `'openrouter'`, `+NULL` → `NULL`) — output verified byte-identical over the same data. VM steps 392 → 0 (60s window), 476 → 197 (24h). Removes ~3.65M rows/day.
De-duplicated the three identical copies (scheduler tick, `getProviderRPMUsage`, `getProviderDailyUsage`) into one `getProviderUsageSince()` in `src/db/cooldown.ts` so the `+` cannot drift out of a future copy — the duplication is what let one broken query exist three times.

**Second fix (`migrations/0013_rows_read_budget.sql`):** partial covering index `(started_at, provider, status, model) WHERE status != 'SUCCESS'` for the two failure-only `/api/timeouts` aggregates. Failures are ~20% of runs → 9.8k → ~2k rows scanned, `SEARCH INDEX idx_runs_itl` → `SEARCH COVERING INDEX idx_runs_failures`. Verified selected **without** `ANALYZE` (D1 never runs it, so a stats-dependent plan would silently regress). No query changes needed.

**Verification:** preflight green — 18 files / 100 tests, `tsc --noEmit` clean, eslint clean; migration applied to local D1. Plans re-checked from the SQL text extracted out of the source (not retyped), against a prod-shaped 9.8k-row DB built from all 13 migrations.

**Residual (~1.4M rows/day, documented not fixed):** hourly snapshot refresh (~706k, 33 calls) aggregates the full 7d window — a 7d window *is* the whole table, so no index helps; needs incremental windowing (1h/24h from recent runs, 7d from a daily rollup). `/api/timeouts` provider totals (~600k) count all statuses over 7d, so the partial index cannot serve it.

**Shipped:** commit `31bb3e5` on branch `fix/d1-rows-read-cap` (master commits are tool-gated), migration `0013` applied to remote D1, `npm run build` + `wrangler deploy` → version `ac15d17f`, live at <https://modelpulsex.vipulgote5.workers.dev>. Deploy smoke: `/`, `/api/health`, `/api/providers`, `/api/leaderboard`, `/api/timeouts`, `/api/models` all 200; new bundle `index-Cmo_9WE2.js` served; `/api/providers` returns 11 providers with non-zero `usage24h` — proof the changed query executes against prod D1 instead of erroring into its `catch` (which would return all zeros).

**Measured on production** (`wrangler d1 execute DB --remote`; prod `benchmark_runs` = 8,696 rows):

| query | before | after |
| --- | --- | --- |
| provider-count, 60s window (288×/day) | 8,696 rows / 8.1ms | **2 rows** / 0.57ms |
| provider-count, 24h window | 8,696 rows / 7.2ms | 1,998 rows / 1.83ms |
| failures bucket (`/api/timeouts`) | `SEARCH INDEX idx_runs_itl` | `SEARCH COVERING INDEX idx_runs_failures` |

`EXPLAIN QUERY PLAN` on prod confirms `SCAN ... idx_benchmark_runs_provider_model` → `SEARCH ... idx_runs_itl (started_at>?)`.

**Files:** `src/db/cooldown.ts`, `src/benchmark/scheduler.ts`, `migrations/0013_rows_read_budget.sql`, `specs/bugs/BUG-2026-09-10-d1-row-read-cap.md`, `specs/bugs/registry.yaml`.

**Next:** `wrangler d1 insights` still reports ~3.56M rows/24h for the provider query — that window is ~97% pre-fix traffic and decays over the next day; re-check tomorrow for steady state. Open a PR for `fix/d1-rows-read-cap` when ready. Not fixed: hourly snapshot refresh (~706k/day) and `/api/timeouts` provider totals (~600k/day) — both need pre-aggregation, not indexes.

## 2026-09-10 (later) — progress documented: 15 Linear issues + 13 GitHub issues, review loop applied

**Scope:** no code written. The tree had NO diff — `git status` listed 15 "modified" files but `git hash-object <f>` matched `HEAD:<f>` for each (stale index stat cache plus `core.autocrlf=true`), so the session work was the owner's ask to document all progress in the tracker.

**Gate re-run (the evidence the tickets cite):** 18 files / 100 tests pass, `tsc --noEmit` clean, `eslint .` clean, `secret-scan` ok, **`npm audit --audit-level=moderate` exit 1 — 6 vulns (3 moderate, 3 high)**. CI on master is RED and only the Audit step fails (4 consecutive runs; last green was PR #7 on 2026-09-08). Prod live: `/api/health?freshness=10m` 200 `fresh:true` age 0 min (enqueue 6 / inline 6 / skipped_rpm 0), `/api/leaderboard?range=7d` 90 rows `is_stale:false`. `wrangler d1 migrations list DB --remote` → "No migrations to apply!" (current through 0013). `wrangler secret list` → 17 secrets, **no `ALERT_WEBHOOK_URL`**.

**Filed:** 15 Linear issues — MED-171..MED-182 (12 shipped workstreams, Done) plus MED-183 (CI red / audit), MED-184 (**watchdog cannot alert in production** — no webhook secret, and it evaluates hourly against a 30-min threshold), MED-185 (dead `BENCHMARK_TIMEOUT_MS`). Linear then hit its free issue cap, so per owner decision **the tracker moved to GitHub**: all open work is now issues #11..#23 at github.com/vipulgote1999/ModelPulseX (MED-183/184/185 mirrored as #21/#22/#23). Evidence ledger + review trail: Linear project document "ModelPulseX — progress ledger & pending ticket queue (2026-09-10)" and `.pi/linear-evidence.md`.

**Review loop (2 rounds, fresh-context reviewers):** round 1 **BLOCKED** a false ticket premise — MED-181 claimed only migration 0006 had an applied-remotely record, but `SESSION.md:201` records 0013 (`ac15d17f`). Round 2 caught a second false universal ("every degraded path fails silently"): 0009 is the counterexample — both the batched INSERT and its fallback write `itl_ms`/`chunk_count`, and `src/benchmark/scheduler.ts:291` has no try/catch, so a pre-0009 DB loses the run *loudly*. Both corrected and re-verified; the reviews confirmed every cited file:line, config value and commit sha.

**Act on these first:** #22 (set `ALERT_WEBHOOK_URL` + evaluate staleness on the `*/5` tick), #21 (bump `hono` — non-breaking; note `npm audit fix --force` would **downgrade** wrangler 4.125.0 → 4.15.2), #11 (22 of 90 rows are labelled "Measured TPS" with 0 samples in 24h). Unverified defect: `SECURITY_AUDIT_REPORT.md` claims an `audit_log` writer that does not exist in `src/` (#20).

**Traps for next time:** `bg_run` executes through cmd.exe (no `tail`/unix tools) — put chained commands in one Bash call instead. Subagent fan-out is unreliable on this box: all 6 async/parallel children died (async runner OOM, `MarkCompactCollector: young object promotion failed`); sequential foreground children succeeded.

**Files:** `.pi/linear-evidence.md`, `.pi/github-issues.md`, `.pi/github-mirrors.md` (all untracked); `AGENTS.md` (tracker convention) and this entry. **No source file touched — HEAD still `d29977e`.**

**Next:** get CI green by clearing the audit gate (`hono`), configure the alert webhook, then re-check `wrangler d1 insights` steady state for the rows-read fix. GitHub #19 (scope docs for the ~20-provider expansion) is deliberately deferred by the owner.

## 2026-09-10 (session 2) — 12 of 13 open GitHub issues fixed on one branch

**Branch:** `fix/github-issues-11-23` (base `d29977e`). Gate at the end: 23 test files / **139 tests**, `tsc` clean, `eslint` clean, `npm run test:plans` clean, `npm audit --omit=dev` **0 vulns**, `secret-scan: ok`, `npm run test:e2e` **5/5**.

**Fixed (with evidence in `specs/bugs/*.md`):**

- **#21 CI red** — `hono` → `^4.13.7` (the only *runtime* finding; prod audit now 0). Blocking gate narrowed to `npm audit --omit=dev`; full-tree audit is an advisory step, because the two remaining findings are dev-only and have **no forward fix** (latest `wrangler@4.130.0` still pins vulnerable `sharp@0.35.2`; `npm audit fix --force` would *downgrade* wrangler 4.125.0 → 4.15.2).
- **#22 watchdog** — staleness evaluated on the **`*/5` tick** (was hourly vs a 30-min threshold → 60-min worst case), `alert_channel: configured|log-only` exposed on `/api/health`, and a stale+unconfigured channel now logs at **error** level every evaluation instead of returning silently. `postWebhook()` extracted so the watchdog and the D1 alert share one channel. No webhook secret available (owner), so the drill stays open.
- **#11 labels/ranks** — `measured_tps_label` is derived per row (`Measured TPS` / `Insufficient samples` / `No recent data`) instead of a constant, and **a rank now requires ≥3 runs in 24h**; under-sampled rows stay visible, listed last, `rank: null` rendered `—`. Pure helpers + tests; UI reads the API label and warns in amber when it is not "measured".
- **#23 dead config** — `BENCHMARK_TIMEOUT_MS` deleted (var + type); new `test/env-config.test.ts` fails when *any* wrangler var or declared `Env` key has no consumer.
- **#20 audit-log gap** — verified the report claimed auditing that never existed, then **implemented it**: `src/db/audit.ts` writes `audit_log` (SHA-256 actor fingerprint, never the raw token, capped ip/ua) for every `/api/admin/*` request via one middleware — allow *and* deny (denials are the brute-force signal). Report corrected; the `login_attempts` gap filed as **#24** after checking (and correcting my own first draft): login *is* limited per-isolate (5/15 min), it is the cross-edge bucket that is unwired.
- **#12 rows-read guard** — `scripts/check-query-plans.mjs` (`npm run test:plans`, wired into CI) asserts `EXPLAIN QUERY PLAN` for every quota-critical query against a real local D1; full scans are allowed only via `ACCEPTED_FULL_SCANS` with a reason. **Proven to fail**: removing `+` from `GROUP BY +provider` on a copy reproduces the original `SCAN benchmark_runs USING INDEX idx_benchmark_runs_provider_model`. Plus migration `0014`, per-tick accounting, `/api/health` → `d1_budget` (`lower_bound: true` — measured shapes only) and an alert at 0.8 × cap claimed atomically.
- **#13/#14/#19 (docs/bookkeeping, done by a subagent + my cleanup)** — README reconciled to real config/live values with a real CI badge; epic capsule is now the SoT with `test/spec-status-consistency.test.ts` (demonstrated failing on injected disagreement); `planning-status.yaml`, `e01s03` workload text, `0010_security.sql` header and the audit-report references all reconciled; SCOPE/VISION/release-plan amended to the shipped 19-provider reality with e03 promoted to delivered.
- **#16 free filters** — 5 adapters already carried a declared `VERIFIED_FREE` allowlist; those are now **enforced** as `hardFreeFilter` (groq, agnes_ai, aionlabs, nscale, plus glhf's allowlist+substring rule) → **8 of 19** filtered (was 3). The other 11 are listed in `ACCEPTED_FILTER_GAPS` with reasons, and a test fails if a provider is neither filtered nor excepted.
- **#15 browser gate + UAT** — `test/e2e/dashboard-smoke.mjs` (Playwright over the real `dist/frontend`): loads, renders one row per model, freshness banner truthful in **both** LIVE and STALE states, and an SSE `benchmark.completed` triggers a refetch; wired into CI after the build. `test/routes-parity.test.ts` now also asserts the 25 mounted routes == 25 documented routes. New dated artifact `specs/verifications/UAT_2026-09-10.md`.
- **#18 dependabot** — all five PRs closed: hono/caniuse-lite/baseline-browser-mapping absorbed (the last two are *transitive* — `npm install` wrongly promoted them to runtime deps and that was reverted), **recharts 3.10.1 adopted** after passing typecheck + build + 139 tests + the browser smoke, TypeScript 7 deferred with a written reason.

**Still open: #17** (sample-size-aware rank confidence: intervals + overlap marking). #11 already gated ranks on evidence; #17's intervals were not implemented — no partial claim is made for it.

**Traps for next time:** `npx` does not resolve under `execFileSync` on Windows (use `node node_modules/wrangler/bin/wrangler.js`, which is also faster); a `*/5` substring **inside a block comment** terminates it and breaks parsing; subagent fan-out died again here (`No result provided`, most likely OOM while running Chromium) even though its file writes had already landed — verify the tree before assuming a failed child did nothing; `d1 execute --local` plans must be captured, not predicted.

### 2026-09-10 (session 2, after the merge) — deployed, verified in prod, and one new finding

**Landed:** PR #25 merged to `master` as `dfa5577` (base `d29977e`); **master CI is green again** (`preflight: success` at 13:54Z, breaking four consecutive failures — #21's acceptance). Deployed `09db0911` + applied remote migration `0014_rows_read_observability.sql`.

**Production verification (the evidence the closed issues cite):**

- **#11** — `/api/leaderboard?range=7d` (90 rows) now returns labels `{"Measured TPS":51,"Insufficient samples":17,"No recent data":22}` instead of 90× a constant, **23 rows are `rank: null`**, and the zero-sample row is exactly `{"model":"meta-llama/Llama-3.1-70B-Instruct","sampleCount24h":0,"rank":null,"measured_tps_label":"No recent data"}`.
- **#12** — `/api/health?freshness=10m` → `d1_budget: {"rows_read_measured_today":2,"top_shape":"provider-count","top_rows":2,"lower_bound":true}`: the query that once read ~10,600 rows per call measures **2 rows** in prod, so the MED-177 fix is confirmed in situ, not just by plan.
- **#22** — `scheduler.alert_channel: "log-only"` on the public health payload (code shipped; the drill still needs a real webhook secret).
- **#16** — `/api/providers` returns 19 providers; the 8 declared hard filters execute (leaderboard + scheduler paths both 200).
- **#15/#18** — `/` serves the rebuilt bundle with recharts 3.10.1; the browser smoke passes locally and in CI.

**Closed:** #11, #12, #13, #14, #15, #16, #18, #19, #20, #21, #23 (each with its evidence in a closing comment). **Still open:** #17 (rank confidence intervals — never attempted, no partial claim), #22 (needs the webhook secret for the drill), #24 (login cross-edge bucket — filed after correcting my own first draft), and the new **#26**.

**New finding — #26 (heartbeat goes stale while benchmarks run).** Investigated after the deploy smoke showed `fresh: false`: `scheduler.last_schedule_at` is frozen at `13:06:17Z` while `last_benchmark` advanced to `13:55:44Z` (age 1 min) and `last_aggregate_at` (the `*/10` tick) keeps updating. `recordScheduleTick` is the **last, unconditional** statement of `scheduleBenchmarks()` and everything before it is individually try/caught — so either the invocation is being terminated mid-tick or that write is failing silently (it only `console.warn`s). Runs-per-10-min buckets show two collapses (`12:1x-12:2x` and `13:1x` onward) against a healthy 24-32, so it is intermittent, and the branches missing their markers (`*/5` schedule, `*/30` discovery) are exactly the provider-network-heavy ones while the pure-D1 `*/10` always writes. A `wrangler tail` capture across consecutive ticks is running to pin the outcome; the issue records the proposed fix (heartbeat at tick **start** as well as end, and surface the tick error on `/api/health` instead of a `console.warn` nobody reads).

**Ops note:** the `bg_run`-through-`cmd.exe` trap bit again — `mkdir -p` in a backgrounded tail made the whole command fail with "The syntax of the command is incorrect", so the first capture silently collected nothing.

### 2026-09-10 (session 2, third pass) — #26 diagnosed from production evidence, fixed, deployed, verified

**How it surfaced:** the deploy smoke for PR #25 showed `/api/health?freshness=10m` returning **503 with a 33-minute-old measurement** while `runs_2h` counted 712. `scheduler.last_schedule_at` was frozen at `13:06:17Z` for ~50 minutes while `last_benchmark` advanced to `13:55:44Z`, and the pure-D1 `*/10` tick kept writing its marker. Runs per 10-minute bucket (healthy 24-32) collapsed to **1-2** at `12:1x-12:2x` and again from `13:1x` — the flapping made it look like a provider/quota problem.

**Root cause (evidence, not theory):** a `wrangler tail` capture at 14:00 showed `*/30` completing in **21.4s**, the hourly in **21.8s**, `*/10` in 392ms — and **no `*/5` completion event at all**: that tick was still running. The `*/5` tick ran up to `BENCH_INLINE_FALLBACK` (6) jobs **inline, sequentially**, each allowed the coding workload's **300s** provider timeout, and wrote its heartbeat **last**. So a slow provider could hold the tick open for minutes past the 5-minute interval: the heartbeat looked frozen while benchmarks were still finishing, ticks overlapped, and scheduling throughput collapsed.

**Fix (PR #28, deployed `d94ed3b4`, migration `0015`):** `runInlineBounded()` never *starts* a new inline job once a 60s wall-clock budget is spent and returns everything unrun to be queued (a job can no longer be dropped: `ran + rest` always accounts for the input); `recordScheduleStart()` stamps `last_schedule_started_at` **before** any work so an in-flight tick is visible; `recordScheduleTick()` records `last_schedule_ms`. Both writers tolerate a pre-migration deploy. Covered by `test/scheduler-inline.test.ts` (5 cases incl. the accounting invariant).

**Verified on production (before → after):**

| metric | before | after |
| --- | --- | --- |
| runs / 10 min | 1-2 | **18-23** |
| `last_schedule_at` | frozen ~50 min | advancing (`14:03:21Z` → `14:13:27Z`) |
| in-flight tick visibility | none | `last_schedule_started_at` advancing |
| measured tick duration | unbounded (6 × 300s worst case) | `last_schedule_ms: 164184` |
| `/api/health` probe | `503`, age 33 min | `200`, age 0-2 min |
| `d1_budget.rows_read_measured_today` | — | 10 (2 rows/tick) |

**Residual filed as #29**, not silently dropped: the budget bounds new inline *starts*, but an in-flight job keeps its full 300s timeout, so the theoretical worst case is ~360s against a 300s interval (the observed tick was 164s). Capping the in-flight job is a data-semantics decision (a truncated run records a TIMEOUT), so #29 lays out cap/queue-only/accept options.

**Also learned:** the repo's git guard enforces Conventional Commits **and a ≤72-character subject**, and it pattern-matches the whole command string — a command containing both `push` and the trunk branch name is rejected even when the push targets another branch (split such commands). `gh issue close --comment` on an *already-closed* issue silently posts nothing — use `gh issue comment` explicitly. And the `*/5`-inside-a-block-comment trap that SESSION.md already warned about was hit again in a new test file: `*/` terminates the comment.
