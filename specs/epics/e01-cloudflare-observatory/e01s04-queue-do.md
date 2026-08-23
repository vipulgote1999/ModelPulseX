# e01s04 — Queue + Cron + Durable Object live + circuit breaker

Status: pending

## Objective
Distribute benchmarks via Queue, schedule via Cron, broadcast completions via DO SSE, enforce concurrency/circuit breaker.

## Tasks
- Cron scheduler `src/benchmark/scheduler.ts`: on `*/5 * * * *` discover eligible free active models → verifyFree → enqueue BenchmarkJob {modelId, benchmark_type, attempt}; respects global 10 / opencode 3 / openrouter 5 / per-model 1 caps configurable via env; hourly cron aggregates + cleanup.
- Queue consumer `queue: consume` in `src/index.ts`: batch handling, calls provider.benchmarkModel, persists to D1 benchmark_runs, updates hourly_model_stats, publishes to DO, respects 429 Retry-After + exponential backoff + jitter, provider circuit breaker (5 consecutive failures -> 60s cooldown).
- Durable Object `src/live/performance-do.ts`: maintains SSE connections GET /api/live, broadcasts `benchmark.completed` events `{type,model,provider,tps,ttft_ms,timestamp}`, prevents duplicate scheduler, short Worker cache.
- Cost protection: skip UNKNOWN pricing before queueing.

## Verify
`npm test -- test/queue-do.test.ts`

## Acceptance
- Cron creates ≤10 concurrent benchmark jobs per tick; per-provider caps respected.
- Queue processes with jitter; 429 cools provider and retries next tick.
- SSE clients receive benchmark.completed within 500ms of DB persist (mock).
