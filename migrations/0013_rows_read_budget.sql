-- 0013_rows_read_budget.sql — narrow the failure-only scans that re-read the whole run table.
--
-- 2026-09-10: the account hit D1's 5M rows-read/day free-tier cap. Analysis in
-- specs/bugs/BUG-2026-09-10-d1-row-read-cap.md.
--
-- This index serves the two failure-only /api/timeouts aggregates:
--   ... WHERE started_at >= ? AND status != 'SUCCESS' GROUP BY ...
-- Only ~20% of runs are failures, so the scan narrows to those rows instead of every run:
--   SEARCH INDEX idx_runs_itl (started_at>?)  ->  SEARCH COVERING INDEX idx_runs_failures (started_at>?)
-- Covering (no table lookup) and chosen by the planner without ANALYZE — verified via
-- EXPLAIN QUERY PLAN on a prod-shaped 9.8k-row database, stats absent. D1 never runs ANALYZE,
-- so a plan that depends on sqlite_stat1 would silently regress.
--
-- The predicate must stay byte-identical to the queries' predicate for SQLite to match the
-- partial index; the queries are src/api/timeouts.ts (failures + topModels).
--
-- Cost: one extra index entry per failed run (~300/day). No query changes required.

CREATE INDEX IF NOT EXISTS idx_runs_failures
  ON benchmark_runs (started_at, provider, status, model)
  WHERE status != 'SUCCESS';
