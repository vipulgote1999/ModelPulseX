-- 0001_initial.sql — ModelPulseX D1 schema (s11) — Cloudflare-native observatory
-- Keep raw 7-14d, hourly 30-90d, metadata indefinite; never store response bodies.

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  provider_model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_free INTEGER NOT NULL DEFAULT 0,
  free_status TEXT NOT NULL CHECK (free_status IN ('FREE','PAID','UNKNOWN','PREVIOUSLY_FREE')),
  context_length INTEGER,
  capabilities TEXT, -- JSON array
  input_price TEXT,
  output_price TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(provider_id, provider_model_id)
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  benchmark_type TEXT NOT NULL CHECK (benchmark_type IN ('short','medium','coding')),
  started_at TEXT NOT NULL,
  first_token_at TEXT,
  completed_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ttft_ms REAL,
  generation_ms REAL,
  tps REAL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','TIMEOUT','RATE_LIMITED','PROVIDER_ERROR','MODEL_UNAVAILABLE','STREAM_ERROR','UNKNOWN_ERROR')),
  error_type TEXT,
  http_status INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  token_estimation_method TEXT CHECK (token_estimation_method IN ('provider','heuristic')) DEFAULT 'provider'
);

CREATE TABLE IF NOT EXISTS hourly_model_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  hour_start TEXT NOT NULL,
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
  UNIQUE(model_id, hour_start, benchmark_type)
);

CREATE TABLE IF NOT EXISTS availability_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER,
  reason TEXT,
  failure_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS benchmark_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seeds: benchmark workloads (deterministic prompts)
INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES
  ('benchmark.short.prompt', 'Return exactly: PONG', datetime('now')),
  ('benchmark.medium.prompt', 'Write a concise 180-220 word summary of why observability matters for LLM APIs. Plain text only.', datetime('now')),
  ('benchmark.coding.prompt', 'Implement a Python function solve(nums, target) that returns indices of two numbers adding to target. Explain complexity and provide working code with a test case. Keep output under 400 tokens.', datetime('now')),
  ('retention.raw_days', '7', datetime('now')),
  ('retention.hourly_days', '30', datetime('now')),
  ('incident.threshold', '3', datetime('now'));
