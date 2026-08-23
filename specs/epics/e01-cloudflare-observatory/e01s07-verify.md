# e01s07 — Verify 16 gates, local run, methodology, deploy docs

Status: pending

## Objective
Prove completeness across s40 gates and enable deploy.

## Tasks
- Run 16 gates: 1 wrangler dev, 2 migrations, 3 discovery, 4 free filtering, 5 streaming benchmark, 6 TPS calc, 7 TTFT calc, 8 queue, 9 cron, 10 DO SSE, 11 7-day API, 12 leaderboard, 13 Zen vs OR comparison, 14 outage detection, 15 cleanup/retention, 16 deploy.
- Test suite covering s35 checklist (TPS,TTFT,token calc, free detection, discovery, adapters, 429, timeout, retry, downtime, aggregates, scoring, D1, SSE) with mocks.
- Docs: README deploy steps (D1 creation, migrations, queue, DO, cron, secrets), .env.example, wrangler environments dev/staging/prod, local dev via wrangler dev --local.
- Cleanup verification: raw 7-14d, hourly 30-90d, aggregates indefinite, no bodies.
- Update specs/state.yaml, execution-status.yaml.

## Verify
`npm test && npm run typecheck && npm run build`

## Acceptance
- All 16 gates green locally (mocked providers) or with real secrets if present.
- README steps reproducible: npm install && npx wrangler dev then /api/health 200.
