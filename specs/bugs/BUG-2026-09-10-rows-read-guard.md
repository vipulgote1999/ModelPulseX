# BUG-2026-09-10-rows-read-guard: nothing stopped the next D1 rows-read breach

GitHub: #12. Severity: high (quota-loss class — the 2026-09-09 breach took the API down).

## Problem

The 2026-09-09 breach ("exceeded the daily D1 free tier limit of 5000000 rows read") was
fixed per query (`GROUP BY +provider` + partial index `0013`), but the fix was
**query-shape dependent and unenforced**:

- CI ran lint/test/typecheck/build/audit/secret-scan — no SQL plan assertion;
- nothing measured rows read from inside the Worker; the only signal was the Cloudflare
  dashboard (`wrangler d1 insights`);
- `/api/health` exposed no budget field even though `observability.enabled: true`.

## Root Cause Analysis

Three gaps, one class:

1. **No regression gate.** `GROUP BY +provider` is load-bearing — the unary `+` is what
   stops SQLite satisfying `GROUP BY` from `idx_benchmark_runs_provider_model` index order
   and forces `SEARCH ... (started_at>?)`. Nothing in CI asserted it, so a future "cleanup"
   of the `+` would silently restore a full 7-day scan, 288×/day.
2. **No in-Worker measurement.** D1 returns `meta.rows_read` per statement, but the value
   was never captured, so consumption was invisible without the dashboard.
3. **No alerting.** Breaching the cap produced a hard failure, not a warning.

## Fix

**1. CI gate — `scripts/check-query-plans.mjs` (`npm run test:plans`, wired into CI).**
Runs `EXPLAIN QUERY PLAN` for every quota-critical shape against a real local D1 (same
engine, same migrations, offline) and requires a range SEARCH on a named index. Full scans
are permitted only via `ACCEPTED_FULL_SCANS` with a written reason, so a *new* full scan
fails the build. Guarded shapes: provider-usage count, `/api/timeouts` failure buckets,
`/api/timeouts` top failing models.

**Proven to fail** — removing the `+` from a copy reproduces the original defect exactly:

```
✗ provider-usage count (...): plan no longer uses the expected range index.
    plan: SCAN benchmark_runs USING INDEX idx_benchmark_runs_provider_model
exit 1
```

**2. Measurement — `src/db/query-cost.ts` + migration `0014_rows_read_observability.sql`.**
`getProviderUsageSince` reports its own `meta.rows_read` through an optional callback at its
single call site (the 5-minute scheduler tick), which accumulates into one row per UTC day
(`rows_read_daily`: day PK, rows_read, top_shape, top_rows, alerted_at).

**3. Visibility + alert.** `/api/health?freshness=N` now returns a `d1_budget` block
(`rows_read_measured_today`, `top_shape`, `cap`, **`lower_bound: true`**). Crossing
`ROWS_READ_ALERT_FRACTION` (default 0.8) × `D1_DAILY_ROWS_CAP` (default 5,000,000) logs at
error level and posts through the *same* webhook channel as the staleness watchdog —
`postWebhook()` was extracted from `watchdogCheck()` so the two cannot drift. The alert slot
is claimed with a conditional UPDATE, so concurrent ticks cannot double-report.

**Honesty note (deliberate):** only instrumented shapes are counted, so the number is a
lower bound on true account consumption — hence `_measured_` in the field name and
`lower_bound: true` in the payload. `/api/timeouts` provider totals remain a full scan
(~600k rows/day) and stay an **accepted, documented exception** in the guard: the query
counts every status over the window, so no index can serve it; the fix is pre-aggregation.

## Acceptance Criteria

- [x] A query that reintroduces a full-table scan fails CI (proven by mutation)
- [x] Rows read are observable without opening the Cloudflare dashboard (`/api/health`)
- [x] Alert fires through the watchdog's channel when the cap fraction is crossed
- [x] Unavoidable scan explicitly excepted with a reason and an upgrade path

## Verification

- `npm run test:plans` → 3 shapes on the range index, 1 accepted exception, exit 0
- mutated copy → exit 1 with the original bad plan
- `npx vitest run test/query-cost.test.ts` → 8 passed; full suite **22 files / 133 tests**
- `tsc --noEmit` clean, `eslint .` clean
- Prod smoke after deploy: `GET /api/health?freshness=10m` → `d1_budget.rows_read_measured_today`
