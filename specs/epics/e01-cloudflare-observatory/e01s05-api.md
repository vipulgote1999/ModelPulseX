# e01s05 — API + aggregation + incidents + comparison + scoring

Status: pending

## Objective
Serve leaderboard/history/comparison/health without scanning raw rows; compute incidents/uptime and weighted Overall Score.

## Tasks
- D1 queries in `src/db/queries.ts`: indexes, hourly aggregation cron `0 * * * *` computes avg/median/p90/p95 TPS/TTFT, success_rate, uptime, request_count per (modelId, hour); raw TTL delete >14d, hourly TTL >90d.
- API routes: GET /api/providers, /api/models (filter provider/free_status), /api/leaderboard?range&provider&benchmark (joins latest+hourly aggregates), /api/models/:id, /api/models/:id/history?range, /api/models/:id/incidents, /api/compare?models=, /api/health. admin POST /api/admin/discover|benchmark|reaggregate|cleanup protected via ADMIN_TOKEN.
- Incidents: outage starts after 3 consecutive failures (configurable), ends on SUCCESS, stores duration/reason, exposes uptime_24h/7d, downtime, incident_count, longest_outage.
- Provider comparison: same model across Zen vs OR (e.g., laguna family) table TPS 24h/7d TTFT 24h/7d uptime/error with winner + recommended provider from data.
- Scoring `src/benchmark/scoring.ts`: Overall Score 40% TPS 25% TTFT 25% Reliability 10% Consistency normalized, profiles reweight (Balanced/Fastest/Lowest Latency/Most Reliable/Coding).

## Verify
`npm test -- test/api.test.ts`

## Acceptance
- Leaderboard returns sorted by overallScore or tps/ttft as requested, using aggregates not raw.
- History endpoint supports 1h/24h/3d/7d with hourly points.
- Comparison endpoint correctly computes winner per metric.
- Scoring profiles change ranking deterministically.
