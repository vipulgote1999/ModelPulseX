# Tech Stack — ModelPulseX

## Stack
- **Runtime:** Cloudflare Workers (ESM, main src/index.ts, compatibility_date 2025-01-01, nodejs_compat), Pages/Workers static for frontend
- **Language:** TypeScript strict, Vite 5, Vitest 2, wrangler 4
- **State:** D1 (SQLite relational) + Durable Objects (SQLite-backed live SSE broadcaster) + Queues (benchmark job distribution) + Cron Triggers (scheduler every 5m, aggregation/cleanup hourly)
- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS + shadcn/ui + Recharts (TPs: TPS, TTFT, reliability, error charts)
- **Secrets:** wrangler secrets (OPENCODE_API_KEY, OPENROUTER_API_KEY, ADMIN_TOKEN)

## Architecture
```
Pages/Workers (frontend static)
        ↓
   Worker API (Hono/itty)
   ├─ providers/opencode-zen.ts + openrouter.ts implements LLMProvider {discoverModels, getModelMetadata, benchmarkModel}
   ├─ benchmark/engine.ts (streaming fetch → TTFT = first_token - started, generation = completed - first_token, TPS = tokens/gen_time) + scheduler.ts (cron → discover → verifyFree → queue) + scoring.ts (0.4 TPS + 0.25 TTFT + 0.25 reliability + 0.1 consistency)
   ├─ db/queries.ts + migrations (providers, models, benchmark_runs, hourly_model_stats, availability_incidents, benchmark_config) + aggregation hourly + retention cleanup 7-14d raw / 30-90d hourly
   ├─ live/performance-do.ts (Durable Object SSE fan-out, prevents duplicate scheduler)
   └─ utils/concurrency.ts, error mapping (SUCCESS/TIMEOUT/RATE_LIMITED/PROVIDER_ERROR/MODEL_UNAVAILABLE/STREAM_ERROR/UNKNOWN_ERROR)
Cron → Queue → Worker consumer → provider adapters
```

## Observed Conventions
- Error handling: structured status enum, outage starts after N consecutive failures, ends on success; uptime/downtime p50/p90/p95 computed.
- API shapes: REST JSON GET /api/* with ?range=1h|24h|7d & provider & benchmark filters; admin POST /api/admin/* protected by ADMIN_TOKEN; SSE GET /api/live.
- Type safety: strict interfaces, no any, LLMProvider contract enforced.
- Observability: hourly aggregates prevent raw-row scans; worker cache + DO live state; SHOW ● LIVE / STALE guards; methodology page explains limits.
- Testing: Vitest mocks provider APIs (no credit cost); tests for tps/ttft/token calc, free detection, discovery, 429 handling, retry, downtime, aggregates, scoring, D1 queries, SSE.

## Signals / Active Considerations
- OpenCode Zen free status heuristic must be verified per-request: *-free suffix + pricing 0; otherwise FREE_STATUS UNKNOWN skip — prevents cost leakage.
- OpenRouter free is strict pricing.prompt==0 && pricing.completion==0; some models report 0 one side but not both → UNKNOWN.
- TPS uses provider usage.output_tokens if present else estimation with clear "estimated" flag; TTFT requires streaming first-token timestamp, not total duration.
- Queue concurrency caps (global 10, opencode 3, openrouter 5, per-model 1) configurable via env; exponential backoff + jitter + circuit breaker essential for 429 isolation.
- 7-day retention must be cheap: hourly_model_stats reduce frontend queries; raw cleanup daily via Cron 0 * * * *.
- Live SSE via Durable Object: must NOT be primary history DB; D1 is SoT, DO only broadcasts new benchmark.completed events.
- Frontend freshness: show Data updated Xs ago + Last benchmark/discovery/aggregate timestamps; never fake real-time if stale.

