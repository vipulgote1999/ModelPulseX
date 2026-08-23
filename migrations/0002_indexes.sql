-- 0002_indexes.sql — performance optimization: avoid scanning raw rows for every dashboard load

CREATE INDEX IF NOT EXISTS idx_models_active_free ON models(active, free_status);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
CREATE INDEX IF NOT EXISTS idx_models_last_seen ON models(last_seen);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_time ON benchmark_runs(model_id, started_at);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started ON benchmark_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_hourly_model_hour ON hourly_model_stats(model_id, hour_start);
CREATE INDEX IF NOT EXISTS idx_incidents_model ON availability_incidents(model_id, started_at);
