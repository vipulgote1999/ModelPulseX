# ModelPulseX — LLM Performance Observatory

> **Cloudflare-native** live benchmark for **FREE** OpenCode Zen + OpenRouter models — *which free model should I use right now, and which has been best over the last 7 days?*

Inspired by [TokenDyno](https://tokendyno.com) (TPS/TTFT leaderboard, sparkline trends, reliability with sample counts, Intelligence Index) but **FREE-only** with **provider comparison**, **7-day history**, **live SSE**, and **dynamic discovery** (no hard-coded model lists).

![stack](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20Queues%20%2B%20Durable%20Objects-orange)
![checks](https://img.shields.io/badge/preflight-npm%20test%20%26%20typecheck-green)

## What it measures (real, not reported)

Every 5 minutes per model (global 10 / Zen 3 / OpenRouter 5 concurrency, per-model 1):

- **Streaming fetch** `POST /v1/chat/completions` `stream:true`
- Records `request_started_at`, `first_token_at` (first `data:` chunk), `completed_at`
- `TTFT = first_token_at - started_at`
- `generation_ms = completed_at - first_token_at`
- `TPS = output_tokens / generation_ms`  — **measured**, never `provider TPS` (same formula TokenDyno uses: output tokens / server-measured generation time)
- Tokens from `usage.completion_tokens` if present else heuristic `ceil(chars/4)` flagged `heuristic`
- Statuses: `SUCCESS | TIMEOUT | RATE_LIMITED | PROVIDER_ERROR | MODEL_UNAVAILABLE | STREAM_ERROR | UNKNOWN_ERROR`
- Outage after **3 consecutive failures** → incident (started_at, ended_at, duration, reason), same as spec

Benchmark prompts (deterministic per `benchmark_type`, never cross-compare):

- `short`: `Return exactly: PONG` (16 tokens) — latency
- `medium`: 180-220 word summary — sustained
- `coding`: Python `solve(nums,target)` + complexity — coding

## Dynamic free discovery — only FREE

- **OpenRouter**: `GET /api/v1/models` → filter `pricing.prompt==0 && pricing.completion==0` (both zero). Mixed 0/paid → `UNKNOWN` skip.
- **OpenCode Zen**: `GET /zen/v1/models` (keyless) → `*-free` suffix or `big-pickle` → `FREE`. Others → `UNKNOWN` skip.
- Missing pricing → `FREE_STATUS=UNKNOWN` skip. **Never** queues unknown/paid.
- Transition `FREE → PAID`: `active=0`, `free_status=PREVIOUSLY_FREE`, **retains last 7d results** (frozen hourly aggregates) and shows *Previously Free* badge — per “if that model is not there in free we should show its last result” requirement.
- Re-discovery hourly + manual `POST /api/admin/discover`.

Live snapshot (2026-08-23): **29 benchmarkable FREE** (Zen 9 + OpenRouter 20 filtered; TokenDyno comparison: 57 total incl. paid Ollama etc. — we cover **all** free variants).

## Architecture — Cloudflare-first (no Redis/Postgres/K8s)

```
Cron */5 * * * * → Scheduler → verifyFree() → Queue (bench-queue, batch 10, 3 retries, DLQ)
                                          ↓
                                  Worker consumer → provider.benchmarkModel() → D1 benchmark_runs
                                                              ↓
                              Durable Object (PerformanceDO) SSE → GET /api/live
                                                              ↓
                                  Hourly Cron 0 * * * *: discovery + hourly_model_stats + retention cleanup
                                                              ↓
React Vite Tailwind shadcn Recharts (SSE live) ← GET /api/leaderboard?range=&provider=&benchmark=&sort=&profile=
```

- **Workers** API + provider adapters + benchmark engine + scoring + aggregation
- **D1** (`providers`, `models`, `benchmark_runs` 7-14d raw, `hourly_model_stats` 30-90d, `availability_incidents` indefinite, `benchmark_config`)
- **Queues** `bench-queue` / `bench-dlq`
- **Durable Object** `PerformanceDO` live SSE (fan-out, not history store) — `event: benchmark` `data: {model, provider, tps, ttft_ms}`
- **Cron** two expressions (UTC): `*/5` scheduler, `0 *` aggregator

Concurrency & cost protection (configurable via `wrangler.jsonc` vars):

```
MAX_GLOBAL=10 MAX_OPENCODE=3 MAX_OPENROUTER=5 MAX_SAME_MODEL=1
```

429 → `Retry-After` + exponential backoff + jitter + provider circuit breaker; `verifyFree()` gate before any queue.

Indexes: `models(active,free_status)`, `benchmark_runs(model_id,started_at)`, `hourly_model_stats(model_id,hour_start)`.

## Frontend — TokenDyno-inspired but FREE-focused

Header `LLM PERFORMANCE OBSERVATORY — OpenCode Zen + OpenRouter FREE MODELS ● LIVE`

- Summary cards: FREE MODELS / ONLINE NOW / BEST TPS / BEST TTFT / BEST RELIABILITY / BENCHMARKS/24H
- **Live leaderboard** sortable: Rank, Model, Provider badge (violet Zen / sky OpenRouter), **TPS now/1h/24h/7d**, TTFT, **7d Uptime** with `n=` hint when `<12` samples (TokenDyno pattern), **Intelligence Index** (Artificial Analysis clickable, e.g. 24.1 → AA page), **Trend sparkline** (24 hourly median TPS buckets), Err%, Status badge, Last Test (time-ago)
- Filters: provider, model, benchmark, sort, profile
- Click rows to pin (max 4) for comparison

Charts (hourly aggregates, not raw):

- **TPS 7-day** (multi-model, provider compare, 1h/24h/3d/7d, tooltip Time/Provider/Model/TPS/TTFT/Status) — measured TPS only
- **TTFT 7-day** (separate axis, never same as TPS)
- **Reliability**: `██████░░████████` per model (`█` online ≥50% success, `░` degraded), 7d uptime/downtime/incidents/longest outage
- **Errors** stacked bars by `timeout | rate_limit | 5xx | 4xx | model_unavailable | stream_error`

- **Same-model provider comparison** (e.g., `laguna-s-2.1-free` vs `poolside/laguna-s-2.1:free`): table `TPS 24h / 7d`, `TTFT 24h / 7d`, `Uptime`, `Error%` per provider, winner highlight + *Recommended provider*
- **Overall Score**: `0.40*TPS + 0.25*TTFT + 0.25*reliability + 0.10*consistency` normalized across active FREE; profiles `Balanced | Fastest | Lowest Latency | Most Reliable | Coding` re-weight
- **Recommendation cards**: `🏆 BEST OVERALL ⚡ FASTEST NOW 🚀 LOWEST TTFT 🛡 MOST RELIABLE 💻 BEST CODING 📈 BEST 7-DAY CONSISTENCY` (links to measurements)

- **Freshness**: `● LIVE Data updated 8s ago` vs `STALE DATA Last measurement: 18m ago` + last benchmark/discovery/aggregate timestamps; never lies about staleness; shows `2h of observed data` when <7d
- `/methodology` transparency page (formulas, prompts, frequency, token counting, free detection, uptime, scoring, retention, limitations like provider load/routing/time/streaming)
- **Only necessary data**: raw 7-14d, hourly 30-90d, aggregates indefinite; no response bodies (unless debug flagged) — D1 <500MB.

SSE live: `EventSource /api/live` → leaderboard re-fetches without refresh on `benchmark.completed`.

## API

```
GET /api/health
GET /api/providers
GET /api/models?provider=&includeInactive=1
GET /api/leaderboard?range=1h|24h|3d|7d&provider=opencode_zen|openrouter&benchmark=short|medium|coding|all&sort=overall|tps|ttft|uptime&profile=balanced|fastest|latency|reliable|coding
GET /api/models/:id
GET /api/models/:id/history?range=1h|24h|3d|7d&benchmark=
GET /api/models/:id/incidents
GET /api/compare?models=1,2  or  ?model=laguna
GET /api/live                    (SSE via DO)
POST /api/admin/discover         (ADMIN_TOKEN)
POST /api/admin/benchmark        {model_id, benchmark_type}
POST /api/admin/reaggregate
POST /api/admin/cleanup
```

Query freshness meta included in leaderboard: `last_benchmark`, `last_aggregate`, `last_discovery`, `is_stale`, `live`.

## TokenDyno inspiration — what we kept / added

| TokenDyno | ModelPulseX |
| ----------- | ------------- |
| TPS now / 24h avg, TTFT now, Reliability 24h with `n=` when sparse, Intelligence Index clickable, sparkline trend, provider badge, sorted headers, last success | Same + **TPS 7d**, **TTFT 7d**, **7d Uptime** (not just 24h), **Overall Score** with profiles, **provider comparison with winner**, **Previously Free retention**, **coding benchmark**, **error/incident timelines**, **SSE live**, **methodology** |
| Samples every 10m (Ollama Pro) vs 60m (Free/Zen) | Scheduler every 5m with caps (10 global) — frequent checks even for free tier; hourly aggregates keep cost low |
| Ollama + Zen + Go coverage | **Zen + OpenRouter FREE only** (all 29 variants), dynamic discovery covers churn (no hard-code) |

## Quickstart

```bash
# 1) install
npm install --legacy-peer-deps  # wrangler peer needs legacy
# 2) env
cp .dev.vars.example .dev.vars  # fill OPENCODE_API_KEY, OPENROUTER_API_KEY, ADMIN_TOKEN
# 3) local D1 + build + dev (Windows also: run.bat, macOS/Linux: ./run.sh)
npx wrangler d1 migrations apply DB --local
npm run build
npm run dev          # wrangler dev --local :8789  (or npm run dev:remote)
# open http://127.0.0.1:8789/  and  http://127.0.0.1:8789/api/health
```

One-click Windows: `run.bat`  (applies migrations, builds, starts dev)  
One-click deploy: `deploy.bat` (typecheck + tests + migrations --remote + `wrangler deploy`)

### Manual ops

```bash
# discover now (instead of waiting hourly cron)
curl -X POST http://127.0.0.1:8789/api/admin/discover -H "Authorization: Bearer $ADMIN_TOKEN"
# trigger cron locally
curl http://127.0.0.1:8789/cdn-cgi/local/scheduled
# queue a single benchmark for a model
curl -X POST http://127.0.0.1:8789/api/admin/benchmark -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"model_id":1,"benchmark_type":"short"}'
# reaggregate & cleanup
curl -X POST http://127.0.0.1:8789/api/admin/reaggregate -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST http://127.0.0.1:8789/api/admin/cleanup -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Deploy to Cloudflare

```bash
wrangler login
wrangler d1 create modelpulsex-db   # once — paste database_id into wrangler.jsonc
wrangler d1 migrations apply DB --remote
wrangler secret put OPENCODE_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put ADMIN_TOKEN
npm run deploy  # or deploy.bat on Windows
# verify
curl https://modelpulsex.vipulgote5.workers.dev/api/health
```

Wrangler bindings needed (already in `wrangler.jsonc`): D1 `DB`, Queues `BENCH_QUEUE`/`bench-queue` + `bench-dlq`, Durable Object `LIVE_DO` (`PerformanceDO`), Crons `*/5 * * * *` + `0 * * * *`, assets `dist/frontend`.

## Scripts

| Script | What |
| -------- | ------ |
| `npm run dev` | `wrangler dev --local :8789` |
| `npm test` | `vitest run` (metrics, discovery, benchmark, scoring, queue, api contracts) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `vite build` (frontend → `dist/frontend` + typecheck) |
| `npm run migrate` / `:local` | `wrangler d1 migrations apply` |
| `npm run deploy` | `wrangler deploy` |
| `run.bat` / `run.sh` | one-click local |
| `deploy.bat` | one-click deploy |

## Tests (no real credits)

```
npm test
```

Covers s35: TPS/TTFT calculation (generation-based, not total), token estimation flag, free detection (Zen suffix, OR 0/0), discovery, adapters (mocked fetch), 429/Timeout/retry (jittered backoff), downtime incident threshold, rolling aggregates, scoring normalization & profiles, D1 schema & index contracts, SSE/D1 shape.

Mock provider APIs — never hits upstream in tests.

## Data retention (only necessary)

- `benchmark_runs` raw 7 days (configurable 7-14 via `benchmark_config.retention.raw_days`), cleanup daily
- `hourly_model_stats` 30 days (30-90 configurable), cleanup daily
- `daily_model_stats` + `models` + `availability_incidents` indefinite for trends
- No `response_text` / request bodies ever persisted (unless explicit debug, TTL-short)

Frontend uses hourly aggregates → no 1000-row scans per page load.

## Environment & secrets

Never in bundle, D1, API, logs:

```
wrangler secret put OPENCODE_API_KEY   # https://opencode.ai/zen
wrangler secret put OPENROUTER_API_KEY # https://openrouter.ai/keys
wrangler secret put ADMIN_TOKEN        # any random string, used as Bearer for /api/admin/*
# optional overrides via wrangler.jsonc vars:
# MAX_GLOBAL_CONCURRENCY etc.
```

Local dev via `.dev.vars` (copy `.dev.vars.example`).

## Batch files

- `run.bat` / `run.sh` — operable program: install → migrate → build → `wrangler dev --local`
- `deploy.bat` — operable one-click deploy (typecheck+tests+build+migrate+deploy)

## Methodology highlights

See `/methodology` in the app. Key honesty points: measurements vary by provider load, network/routing, time of day, model version, streaming chunking, prompt size; generation window; freeness verified at discovery + pre-queue; unknown pricing never benchmarked. Windowed TPS/TTFT are **medians** and require minimum sample sizes (2 for 1h, 3 for 24h, 5 for 7d) before a figure is shown.

## Operations

- **Freshness probe**: `GET /api/health?freshness=15` returns 503 when the newest measurement is older than 15 minutes — point UptimeRobot/BetterStack (or any monitor) at it to catch a stalled pipeline that plain health checks would miss.
- **Staleness watchdog**: the hourly cron alerts `ALERT_WEBHOOK_URL` (Discord/Slack-compatible `{content,text}` body; set via `wrangler secret put ALERT_WEBHOOK_URL`) when data goes stale, rate-limited to one alert/hour. Threshold: `STALE_ALERT_MINUTES` var (default 30).
- **Scheduler heartbeat**: every */5 tick persists enqueue/skip counts (migration `0006_scheduler_health.sql`) surfaced via `/api/health` and leaderboard `meta.scheduler`. Apply migrations with `npm run migrate` (remote) after deploying if your API token has D1 permissions; until applied, heartbeat fields read null and everything else works.
- **Inline fallback**: `BENCH_INLINE_FALLBACK` (default 6) runs the first N selected jobs inside each cron invocation so baseline coverage survives even if queue delivery stalls; the queue carries the remainder with consumer concurrency 8.
- **Cooldown escalation**: providers failing on quota/429 back off exponentially (base → 2× per repeat, capped at `COOLDOWN_MAX_MS`, default 2h) honoring provider `Retry-After`, so dead keys stop consuming benchmark capacity.
- **D1 rows_read budget** (free tier 5M/day — exceeded 2026-09-05): scheduler LRU reads maintained `models.last_benchmark_at` (migration `0011`, stamped by inserts) instead of scanning `benchmark_runs` every */5 tick; leaderboard merges latest-row + window medians into one GROUP BY + indexed self-join and edge-caches 30s (`caches.default`); retention cleanup runs daily 00 UTC; dashboard polls 60s with 10s-debounced SSE refetch (hidden-tab skip). Watch usage via `wrangler d1 insights` / dashboard before adding new per-request or per-tick scans.
- **CI**: GitHub Actions runs lint + vitest + typecheck on every push/PR (`.github/workflows/ci.yml`).

## verification — 16 gates (s40)

Checked locally with `npm test && npm run typecheck && npm run build`, `wrangler dev`, `wrangler d1 migrations apply`, `/api/health` → `/api/models` (29 free) → `/api/leaderboard` (29 with sparkline/intelligence) → `/api/models/:id/history` (24h/7d hourly) → `/api/compare` (laguna Zen vs OR with winner) → incidents → cleanup.

## License

MIT — data via your own benchmarks; Intelligence Index via Artificial Analysis (see links).
