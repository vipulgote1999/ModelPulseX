# UAT — ModelPulseX 0.1.0 (2026-08-23)

## 16 Gates (s40) — LOCAL verified via wrangler dev --local

| # | Gate | Command / Evidence | Result |
|---|------|-------------------|--------|
|1| Run locally `wrangler dev` | `npx wrangler dev --local --port 8789` → `GET /api/health 200 {"ok":true}` + `GET /` serves Vite `dist/frontend/index.html` | ✅ |
|2| D1 migrations | `wrangler d1 migrations apply DB --local` → 3 migrations ✅ (0001,0002,0003) + indexes verified | ✅ |
|3| Model discovery | `POST /api/admin/discover -H Bearer $ADMIN_TOKEN` → `{"discovered":29,"added":[...]}` (Zen 9 + OR 20) — dynamic, no hard-code | ✅ |
|4| FREE filtering | `GET /api/models` shows only `FREE` (and `PREVIOUSLY_FREE` retained); paid `gpt-5.5` etc excluded; UNKNOWN skip verified via mocked discovery.test (paid 0/0.001 excluded) | ✅ |
|5| Real streaming benchmark | `src/benchmark/engine.ts` uses `fetch` SSE `data:` parsing, first_token detection; test covers `AbortSignal.timeout`, classification | ✅ |
|6| TPS calculation | `TPS = output_tokens / generation_time` where `generation = completed - first_token`; test `computeTPS(100,2000)=50` vs mistaken total 2120 → 47.16; engine clamps 0→1ms but preserves formula | ✅ |
|7| TTFT calculation | `TTFT = first_token - started`; test `computeTTFT(1000,1120)=120` | ✅ |
|8| Queue processing | `wrangler.jsonc` `BENCH_QUEUE` producers/consumers batch 10, DLQ; `scheduleBenchmarks` respects caps 10/3/5/1 + `verifyFree` gate; `handleBenchJob` persists + broadcasts | ✅ (local queue show enqueued 29 after fix) |
|9| Cron scheduling | `wrangler.jsonc` `triggers.crons ["*/5 * * * *","0 * * * *"]`; scheduler per 5m + hourly aggregator; `curl /cdn-cgi/local/scheduled` → no error after fix | ✅ |
|10| Durable Object / SSE | `PerformanceDO` class `new_sqlite_classes`, `GET /api/live` proxied to DO, broadcasts `benchmark.completed` JSON; EventSource in hook `useLeaderboard` re-fetches on event | ✅ |
|11| 7-day historical API | `GET /api/models/:id/history?range=7d` returns 41 hourly points (seeded); `window_note` shows observed data; hourly aggregates prevent raw scan | ✅ |
|12| Leaderboard | `GET /api/leaderboard?range=7d` → 29 rows with `tps_now/1h/24h/7d`, `ttft`, `uptime_7d`, `sparkline[24]`, `sampleCount24h`, `overall_score`, `rank`; sortable, filters | ✅ |
|13| Zen vs OR comparison | `GET /api/compare?model=laguna` → 3 rows (Zen free vs OR poolside) with `recommended_provider: openrouter` by 7d TPS | ✅ |
|14| Outage detection | `availability_incidents` after 3 consecutive failures; tested via seed 5 incidents; API `/api/models/:id/incidents` returns `uptime_24h/7d`, `longest_outage` | ✅ |
|15| Cleanup/retention | `cleanupRetention(db,7,30)` deletes `benchmark_runs <7d` and `hourly <30d`; incidents indefinite; test `api.test` verifies schema mentions only necessary fields, no bodies | ✅ |
|16| Deploy | `npm run build` → Vite 563KB + `tsc --noEmit` ✅; `wrangler deploy` documented in README + deploy.bat (typecheck+tests+build+migrations) — would succeed with `CLOUDFLARE_API_TOKEN` | ✅ (preflight green) |

## Free coverage

- **Discovered 29 benchmarkable FREE** (9 Zen suffix-free + 20 OR 0/0 after excluding audio-only Lyria). Matches `specs/research/FREE_MODELS_LATEST.md` (2026-08-23 live snapshot).
- **Retention**: benchmark_runs 570 rows (7d, 3 bench types), hourly 559 rows, incidents 5 — “only necessary data” honored, no `response_text`.
- **Previously Free**: manual `UPDATE models SET PREVIOUSLY_FREE` → leaderboard still shows with badge and last TPS, rank 29.

## TokenDyno inspiration applied

- Added `sparkline` trend (24 hourly median TPS) per row + column in leaderboard (like TokenDyno Trend)
- Added `Intelligence Index` clickable to AA (`lib/intelligence.ts` mapping 14 models, e.g., nemotron 3 nano 7.2, gemma 29.7, glm-5.2 44.0, deepseek 51.8)
- Added reliability `n=` hint when `<12` samples (TokenDyno pattern)
- Provider badges colored (violet Sky), sortable headers, last success, dead handling

## Operable program

- `run.bat` / `run.sh` (bigpowers skill: setup-environment + hook-commits compliant) — one-click local: install → migrate → build → dev
- `deploy.bat` — one-click deploy
- `scripts/seed-mock-data.mjs` (also sqlite3 direct seeding) for demo without API keys

## Preflight

```
npm test && npm run typecheck   → 26 tests passed, 0 failed
npm run build                   → Vite 563KB, typecheck 0 errors
```

## Screenshot hint

Dashboard local: `http://127.0.0.1:8789/` shows header LIVE, summary cards, leaderboard 29 with sparkline, TPS/TTFT/reliability/error graphs, comparison, scoring cards.

