# BUG-2026-09-10 — D1 rows-read cap exceeded (5M/day)

**Severity:** high · **Priority:** high · **Scope:** `src/db/cooldown.ts`, `src/benchmark/scheduler.ts`, `src/api/timeouts.ts`, `migrations/0013`

## Symptom

Cloudflare D1 blocked reads on 2026-09-09: *"You have exceeded the daily D1 free tier limit of 5000000 rows read"*.
Dashboard reported the top consumers by rows read:

| Query | Calls | Rows read | Rows/call |
| --- | --- | --- | --- |
| `SELECT provider, COUNT(*) FROM benchmark_runs WHERE started_at >= ? GROUP BY provider` | 353 | **3.74M (74%)** | 10.6k |
| snapshot 7d `GROUP_CONCAT` aggregate (`src/db/snapshot.ts`) | 33 | 706k | 21.4k |
| `/api/timeouts` failure aggregates (`src/api/timeouts.ts`) | 58 | 651k | 11.2k |
| everything else | — | ~200k | — |

`benchmark_runs` holds ~10.6k rows (7-day retention, ~1.4k runs/day). **Every one of the top three
queries reads the entire table on every call.**

## Root cause

`WHERE started_at >= ? GROUP BY provider` is planned as a **full index scan**:

```text
EXPLAIN QUERY PLAN
  SCAN benchmark_runs USING INDEX idx_benchmark_runs_provider_model
```

`idx_benchmark_runs_provider_model(provider, model)` has `provider` as its leading column, so SQLite
satisfies `GROUP BY provider` straight from the index — no temp b-tree — and the planner prefers that
over the `started_at` range index. **`started_at >= ?` is never used as an access path.** The filter is
applied per row *after* the whole table is scanned.

This is independent of optimizer statistics: reproduced identically with and without `ANALYZE`, and
reproduced with a covering `(started_at, provider)` index present. A subquery barrier does not help
either. Only two shapes produce a range scan — verified by `EXPLAIN QUERY PLAN`:

| Variant | Plan |
| --- | --- |
| `GROUP BY provider` (current) | `SCAN INDEX idx_benchmark_runs_provider_model` ❌ |
| `GROUP BY +provider` | `SEARCH INDEX idx_runs_itl (started_at>?)` ✅ |
| `+` covering index, no `+` on column | `SCAN INDEX ...` ❌ |
| `+` covering index **and** `INDEXED BY` hint | `SEARCH COVERING INDEX ...` ✅ |

Impact: the scheduler's RPM limiter wants a **60-second** window but pays for **7 days** of rows —
288 cron ticks/day × 10.6k rows = 3.05M rows/day to count a handful of requests.

`GROUP BY +provider` is safe: unary `+` in SQLite returns its operand unchanged (`+'openrouter'` →
`'openrouter'`, `+NULL` → `NULL`). Grouped output is byte-identical — verified against the unmodified
query over the same data.

## Fix

1. **`GROUP BY +provider`** in the shared provider-usage query. De-duplicate the three identical copies
   (scheduler, `getProviderRPMUsage`, `getProviderDailyUsage`) into one `getProviderUsageSince()` so the
   `+` can't drift out of a future copy. This alone removes ~3.65M rows/day.
   Measured on a 9.8k-row prod-shaped DB: VM steps 392 → 0 (60s window), 476 → 197 (24h window).
2. **Partial covering index `idx_runs_failures`** (`WHERE status != 'SUCCESS'`) for the two
   failure-only `/api/timeouts` aggregates. Failures are ~20% of runs, so those scans narrow from
   9.8k → ~2k rows: `SEARCH INDEX idx_runs_itl` → `SEARCH COVERING INDEX idx_runs_failures`.
   Picked up by the planner without `ANALYZE` (D1 never runs it) and with no query changes.

## Verification

- [x] `EXPLAIN QUERY PLAN` on a prod-shaped DB shows `SEARCH ... (started_at>?)`, not `SCAN`, for both changed shapes
- [x] `GROUP BY +provider` returns identical rows to `GROUP BY provider` (equality assertion)
- [x] `npm test && npm run typecheck && npm run lint` green
- [x] Confirmed against **production** D1 (`EXPLAIN QUERY PLAN` via `wrangler d1 execute DB --remote`):
      `SCAN benchmark_runs USING INDEX idx_benchmark_runs_provider_model` →
      `SEARCH benchmark_runs USING INDEX idx_runs_itl (started_at>?)`
- [x] rows read **measured on prod** (8,696 rows in `benchmark_runs`):
      60s window 8,696 → **2** (0.57ms); 24h window 8,696 → 1,998 (1.83ms)
- [x] `/api/providers` returns 11 providers with non-zero `usage24h` — proves the query executes
      rather than erroring into its `catch` (which would return all zeros)

## Not fixed here (residual cost, ~1.4M rows/day)

- **Snapshot refresh** (`src/db/snapshot.ts`, ~706k/day, 33 calls): aggregates the full 7-day window
  every hour. Index changes cannot help — a 7-day window *is* the whole table. Reducing it needs
  incremental windowing (recompute 1h/24h from recent runs, 7d from a daily rollup).
- **`/api/timeouts` provider totals** (~600k/day): counts *all* statuses over 7 days, so the partial
  index cannot serve it. Edge-cached 60s already; 58 origin hits/day.
