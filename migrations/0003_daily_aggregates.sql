-- 0003_daily_aggregates.sql — optional daily aggregates indefinite for long trends (P2), kept minimal.
CREATE TABLE IF NOT EXISTS daily_model_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  day_start TEXT NOT NULL,
  benchmark_type TEXT NOT NULL,
  avg_tps REAL,
  median_tps REAL,
  avg_ttft REAL,
  median_ttft REAL,
  success_rate REAL,
  uptime REAL,
  request_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model_id, day_start, benchmark_type)
);
CREATE INDEX IF NOT EXISTS idx_daily_model_day ON daily_model_stats(model_id, day_start);
