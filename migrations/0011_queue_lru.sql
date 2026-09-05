-- 0011_queue_lru.sql — rows_read fix: scheduler LRU ordering without scanning benchmark_runs.
-- selectJobs ran LEFT JOIN benchmark_runs ... GROUP BY every 5 min (full ~9k-row scan,
-- ~2.6M rows_read/day — over half the free-tier budget). Maintained last_benchmark_at
-- column turns the tick into an indexed models-only read (~150 rows).

ALTER TABLE models ADD COLUMN last_benchmark_at TEXT;

-- Queue hot path: free + enabled filter with LRU ordering (NULLS FIRST = never-benchmarked first)
CREATE INDEX IF NOT EXISTS idx_models_queue_lru ON models (
    free_status, active, benchmark_enabled, last_benchmark_at
);

-- One-time backfill from existing runs (single pass, ~9k reads once)
UPDATE models SET
    last_benchmark_at = (
        SELECT MAX(benchmark_runs.started_at)
        FROM benchmark_runs
        WHERE benchmark_runs.model_id = models.id
    )
WHERE last_benchmark_at IS NULL;
