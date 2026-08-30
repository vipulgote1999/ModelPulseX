-- 0009_itl.sql — inter-token latency (streaming smoothness) metric
-- benchmark_runs: per-run median chunk gap + observed chunk count.
-- Aggregates: median/p90 ITL per bucket, mirroring the tps/ttft percentile columns.

ALTER TABLE benchmark_runs ADD COLUMN itl_ms REAL;
ALTER TABLE benchmark_runs ADD COLUMN chunk_count INTEGER;

ALTER TABLE hourly_model_stats ADD COLUMN median_itl REAL;
ALTER TABLE hourly_model_stats ADD COLUMN p90_itl REAL;

ALTER TABLE tenmin_model_stats ADD COLUMN median_itl REAL;
ALTER TABLE tenmin_model_stats ADD COLUMN p90_itl REAL;

CREATE INDEX IF NOT EXISTS idx_runs_itl ON benchmark_runs(started_at, itl_ms);
