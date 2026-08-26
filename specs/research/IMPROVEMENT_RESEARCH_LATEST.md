# ModelPulseX — Improvement Research (2026-08-25)

In-depth review of the live system (<https://modelpulsex.vipulgote5.workers.dev>) + codebase
(19 providers, ~4.7k LOC src, 359 LOC tests) + external landscape research.
Findings are prioritized WSJF-style: P0 = core value broken, P1 = high leverage, P2 = differentiation/ops polish.

---

## 🔴 P0-1: Production data pipeline is STALLED (core value broken)

**Evidence (live API, 2026-08-25T17:48Z):**

- `meta.last_benchmark = 2026-08-25T03:56:17Z` → **14h with zero new measurements**
- Freshness across all 152 leaderboard rows: `<1h: 0 | 1–6h: 0 | 6–24h: 139 | 1–3d: 4`
- `is_stale: true`, `online_now: 0` — yet discovery ran at 17:00Z (hourly cron fires fine)
- Top-ranked model (`allam-2-7b`, groq): `sampleCount24h: 2`, sparkline `[200, 1562.5]`

A "performance observatory" whose pulse stopped 14h ago fails its vision statement
("which free model should I use **right now**"). The dashboard honestly shows STALE,
but nobody is watching — there is no alerting.

**Likely root causes to investigate (in order):**

1. Cooldown cascade: quota/credit errors set 15-min provider cooldowns; if most of the 19
   provider keys are exhausted/expired, `scheduleBenchmarks` enqueues 0 every cycle and
   fails silently (return value `{enqueued}` is never monitored).
2. Serial queue consumer: `queue()` processes a batch of 10 in a sequential for-loop;
   10 × up-to-30s jobs ≈ 5 min per batch — right at batch timeout, causing retry storms
   and DLQ growth. Check `bench-dlq`.
3. Cron misfire on `*/5 * * * *` (discovery on `0 * * * *` proves only the hourly trigger).

**Fix plan:**

- [ ] Diagnose live: check queue depth/DLQ in dash.cloudflare.com, worker logs
      (`wrangler tail`), `provider_cooldowns` table contents via admin endpoint or D1 console.
- [ ] Enable **Queues consumer concurrency** (`max_concurrency` in wrangler.jsonc consumer,
      supports up to 250 concurrent consumers) and process messages with
      `Promise.all`-style parallelism inside the batch (respecting per-provider caps) instead
      of the serial for-loop.
- [ ] Add a **staleness watchdog**: hourly cron already runs — after aggregation, if
      `MAX(started_at)` older than N minutes, publish a DO event + write an incident row +
      optionally POST to a webhook (Discord/email). Cheap self-monitoring.
- [ ] External heartbeat: point UptimeRobot/BetterStack/CronAlert at `/api/health`
      variant that returns non-200 when data is stale (e.g., `/api/health?freshness=15m`).
- [ ] Surface scheduler health in the UI meta block: `last_enqueued_count`,
      `active_provider_cooldowns`, `dlq_size` (from admin endpoint).

---

## 🔴 P0-2: Statistical rigor — rankings built on 1–2 samples

Industry standard (Artificial Analysis methodology): **median (P50) over trailing window**,
p90/p99 for latency tails, sustained measurement. ModelPulseX currently shows means over
tiny samples (`sampleCount24h: 2` producing `tps_now: 1562.5` and rank #1).

**Fix plan:**

- [ ] Switch displayed metrics to **median** over the window; keep mean as secondary.
- [ ] Enforce **minimum sample size** (e.g., n≥3 for "now", n≥5 for 24h) — below threshold
      show "insufficient data" instead of a number. Prevents 2-sample spikes from ranking #1.
- [ ] Store & expose **p50/p90/p99 TTFT** and TPS in hourly aggregates (SQL is trivial:
      already have raw rows per hour).
- [ ] Flag estimated-token results distinctly in scoring (currently `estimated` flag exists
      but scoring treats it identically).

---

## 🟠 P1-1: Provider registry refactor — kill the 6-file change dance

Adding one provider today touches: `src/providers/<new>.ts`, `src/providers/index.ts`,
`src/types.ts` (ProviderName union + Env vars), `src/utils/concurrency.ts` (×2 interfaces),
`wrangler.jsonc` vars, README. Also:

- `runDiscovery()` contains "one-time" hardcoded cleanups that run **every hour**:
  tokenrouter DELETE-by-pattern and an Ollama 7-model allowlist — this violates our own
  "never hardcode model lists" convention and will silently delete legitimately-free new
  models.
- `getCap()` is a 20-branch if-chain mirroring config that's already keyed by name.
- `providerFor(name)` constructs all 19 provider instances per lookup (called per job!).

**Fix plan:**

- [ ] Single `PROVIDER_DESCRIPTORS` table: `{ name, adapterFactory, defaultConcurrency,
      defaultRPM, freeDetection: 'suffix'|'pricing'|'allowlist', notes }`. Derive types,
      concurrency lookups, and wrangler var docs from it.
- [ ] Move cleanup logic into migration SQL or a versioned `data_fixes` table with an
      `applied_at` guard so it truly runs once.
- [ ] Cache constructed providers in module scope keyed by env (or build once per request
      in index.ts and pass down).

## 🟠 P1-2: Break up `createApi` (complexity 182, 600 lines)

Split Hono app into route factories per resource: `routes/models.ts`,
`routes/leaderboard.ts`, `routes/history.ts`, `routes/admin.ts`, `routes/live.ts`.
Each ≤150 lines, independently testable. Same treatment later for `scheduleBenchmarks`
(complexity 56) — extract LRU selection + RPM budgeting into pure functions.

## 🟠 P1-3: Test the scheduler brain

The most complex logic (LRU rotation, round-robin caps, RPM budgeting, cooldown filtering,
incident streak detection) has **zero unit tests** — only the engine has coverage.
19 provider adapters share no contract test.

**Fix plan:**

- [ ] Pure-function extraction makes these testable without D1: `selectJobs(models,
      cooldowns, rpmUsage, config) → BenchJob[]`, `classifyCooldown(result) → action`.
- [ ] Provider contract test suite: run each adapter's discovery/benchmark against mocked
      OpenAI-compatible fetch; assert metadata mapping + error classification.
- [ ] Incident edge cases: exactly-at-threshold streak, reopen-after-close.

---

## 🟡 P2-1: Differentiation vs the landscape

| Competitor | What they have that we don't |
| --- | --- |
| Artificial Analysis | p50/p90/p99, E2E response time, Intelligence Index, 72h median windows |
| OpenRouter /benchmarks | 2.4M reproducible task evals, telemetry links per score |
| llm-stats / llm-registry / WhatLLM | quality+speed composite, provenance tracking, head-to-head UX |

Our moat stays: **real-world streaming performance of FREE models specifically**, cross-provider
same-model comparison, zero-cost Cloudflare-native ops. To sharpen it:

- [ ] **Inter-token latency (ITL)** — cheap to compute from streaming chunk timestamps;
      differentiates smooth-vs-choppy streaming that TPS hides.
- [ ] **Free-tier awareness**: show each provider's documented RPM/RPD next to results
      ("fastest AND 14,400 req/day") — no competitor centers this for free models.
- [ ] **Correctness signal from existing workloads**: coding workload prompts can be
      verified deterministically (expected output substring) — adds a light quality score
      without LLM-judge cost (respects "no LLM-based scoring" constraint: rule-based verify).
- [ ] **Public API docs page** (OpenAPI JSON + simple /docs UI) — e03 item, low effort.
- [ ] **Embed/share cards** (OG image of current top-5) — free viral loop, static generation
      on cron.

## 🟡 P2-2: Ops hardening

- [ ] **CI**: GitHub remote exists (`vipulgote1999/ModelPulseX`) but no workflow. Add
      `.github/workflows/ci.yml`: vitest + typecheck (+ deploy on main with wrangler-action).
- [ ] **Commit hygiene**: working tree has uncommitted engine/test changes since Aug 23.
- [ ] **Lint gate**: `npm run lint` is a no-op fallback ("no config"). Add eslint (flat cfg)
      or biome; wire into preflight.
- [ ] **Analytics Engine binding**: `writeDataPoint()` per benchmark result (provider,
      status, tps, ttft, duration) → free operational time-series for scheduler health
      dashboards without touching D1 quotas.
- [ ] **state.yaml drift**: records `git.remote: null`; actual remote exists. Update.
- [ ] Queue consumer: consider `max_batch_size` 10→25 + `max_concurrency`, and parse
      `Retry-After` from 429 responses instead of fixed 60s cooldown.

---

## Throughput math (why freshness collapsed)

152 models × 3 workloads; global cap 16 per */5 cron = 192 jobs/hour best case → full sweep
of ONE workload ≈ 47 min, all three ≈ 2.4h — before any cooldown/RPM loss. Serial consumer
(batch 10 × ~30s) can drain <120 jobs/hour. Combined with provider-wide 60s–15min cooldowns
on quota errors, effective coverage collapses to near zero — exactly what production shows.

Recommended target: consumer concurrency 4–8 + per-provider parallelism ⇒ ≥500 jobs/hour,
full 3-workload sweep ≈ 55 min, restoring sub-hourly freshness for every model.

---

## Suggested sequencing

1. **P0-1 diagnose + fix stall** (consumer concurrency, DLQ check, watchdog) — restores core value.
2. **P0-2 medians + min-samples** (small diff, big credibility win).
3. **P1-1/P1-2/P1-3 refactor + scheduler tests** (before adding more providers).
4. **P2 items** in e02/e03 epics as planned (methodology hardening, third provider ops polish).
