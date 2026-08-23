-- 0004_optimize_indexes.sql — I/O optimization: covering and composite indexes for dashboard hot paths
-- Ensures leaderboard/history/compare use index-only or range scans, avoids full table scans.

-- benchmark_runs: hot filters are started_at >= ? and model_id IN (...) and benchmark_type=?
-- Existing idx_benchmark_runs_model_time (model_id, started_at) covers model_time but not benchmark_type
-- Add composite for time+type and provider/model lookups
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started_type ON benchmark_runs(started_at, benchmark_type);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_started_type ON benchmark_runs(model_id, started_at, benchmark_type);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_provider_model ON benchmark_runs(provider, model);
-- For leaderboard lastRun window partition (model_id, started_at DESC) already exists, but ensure covering status
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_status_time ON benchmark_runs(model_id, status, started_at);

-- hourly_model_stats: leaderboard aggregates filter hour_start >= ? and benchmark_type
CREATE INDEX IF NOT EXISTS idx_hourly_hour_type ON hourly_model_stats(hour_start, benchmark_type);
CREATE INDEX IF NOT EXISTS idx_hourly_model_hour_type ON hourly_model_stats(model_id, hour_start, benchmark_type);
-- Cover median_tps/uptime for sparkline + aggregates
CREATE INDEX IF NOT EXISTS idx_hourly_model_hour_median ON hourly_model_stats(model_id, hour_start, median_tps);

-- models: leaderboard fetch (free_status, active) and provider join
CREATE INDEX IF NOT EXISTS idx_models_free_active_provider ON models(free_status, active, provider_id);
CREATE INDEX IF NOT EXISTS idx_models_provider_model ON models(provider_id, provider_model_id);

-- availability_incidents: already indexed model, but add open incident filter
CREATE INDEX IF NOT EXISTS idx_incidents_open ON availability_incidents(model_id, ended_at);

-- benchmark_config is tiny, no index needed
