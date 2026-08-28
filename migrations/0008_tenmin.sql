-- 0008_tenmin.sql — 10-minute aggregation buckets for 5–10m live lines
-- Mirrors hourly_model_stats but at 10-minute granularity. Enables per-provider
-- 5–10m freshness without bloating hourly aggregates (hourly kept for 30-90d, tenmin for 30d).
-- Retention: tenmin rows older than 30 days are purged by cleanupRetention (see 0001 retention).

CREATE TABLE IF NOT EXISTS tenmin_model_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  bucket_start TEXT NOT NULL,
  benchmark_type TEXT NOT NULL,
  avg_tps REAL,
  median_tps REAL,
  p90_tps REAL,
  p95_tps REAL,
  avg_ttft REAL,
  median_ttft REAL,
  p90_ttft REAL,
  p95_ttft REAL,
  success_rate REAL,
  error_rate REAL,
  uptime REAL,
  request_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model_id, bucket_start, benchmark_type)
);

-- Hot path indexes: range scan on bucket_start + benchmark_type, and per-model lookups for history
CREATE INDEX IF NOT EXISTS idx_tenmin_bucket_type ON tenmin_model_stats(bucket_start, benchmark_type);
CREATE INDEX IF NOT EXISTS idx_tenmin_model_bucket_type ON tenmin_model_stats(model_id, bucket_start, benchmark_type);
CREATE INDEX IF NOT EXISTS idx_tenmin_model_bucket ON tenmin_model_stats(model_id, bucket_start);

-- Backfill hint: incremental aggregation will populate from now; historical 10m can be rebuilt
-- from benchmark_runs on demand via computeTenminAggregates (same GroupConcat percentile logic as hourly).
