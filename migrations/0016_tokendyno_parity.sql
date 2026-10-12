-- 0016_tokendyno_parity.sql — e04s01: hybrid TPS method + speed-probe workload.
-- TokenDyno parity: every benchmark run records HOW its TPS was measured
-- (inter-token for smooth streams, wall-clock fallback for bursts), and the
-- observatory gains a second TokenDyno-identical speed probe (300-token cap).
--
-- SQLite cannot ALTER a CHECK constraint, so benchmark_runs is rebuilt:
--   1. widen benchmark_type CHECK to ('short','medium','coding','speed')
--      ('short'/'medium' retired but historically present — keep accepted)
--   2. add tps_method TEXT CHECK (tps_method IN ('inter-token','wall-clock'))
-- DROP TABLE also drops that table's indexes, so every benchmark_runs index
-- from 0002/0004/0009/0013 is recreated below (byte-identical definitions).
-- Data is copied, never fabricated: INSERT ... SELECT preserves all rows.
--
-- Reversibility: additive + constraint-widening only. Revert = re-run with the
-- old CHECK and without the tps_method column selected (down-migration:
-- rebuild from this table selecting all columns except tps_method, with the
-- 0001 CHECK text). Leaving 0016 applied on a code revert is safe: the
-- tps_method column is nullable and inserts tolerate its absence (see
-- insertBenchmarkRun fallback in src/db/queries.ts).

CREATE TABLE IF NOT EXISTS benchmark_runs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  benchmark_type TEXT NOT NULL CHECK (benchmark_type IN ('short','medium','coding','speed')),
  started_at TEXT NOT NULL,
  first_token_at TEXT,
  completed_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ttft_ms REAL,
  generation_ms REAL,
  tps REAL,
  tps_method TEXT CHECK (tps_method IN ('inter-token','wall-clock')),
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','TIMEOUT','RATE_LIMITED','PROVIDER_ERROR','MODEL_UNAVAILABLE','STREAM_ERROR','UNKNOWN_ERROR')),
  error_type TEXT,
  http_status INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  token_estimation_method TEXT CHECK (token_estimation_method IN ('provider','heuristic')) DEFAULT 'provider',
  itl_ms REAL,
  chunk_count INTEGER
);

INSERT INTO benchmark_runs_new
  (id, model_id, benchmark_type, started_at, first_token_at, completed_at,
   input_tokens, output_tokens, ttft_ms, generation_ms, tps, tps_method,
   status, error_type, http_status, provider, model, token_estimation_method,
   itl_ms, chunk_count)
SELECT
  id, model_id, benchmark_type, started_at, first_token_at, completed_at,
  input_tokens, output_tokens, ttft_ms, generation_ms, tps, NULL,
  status, error_type, http_status, provider, model, token_estimation_method,
  itl_ms, chunk_count
FROM benchmark_runs;

DROP TABLE benchmark_runs;

ALTER TABLE benchmark_runs_new RENAME TO benchmark_runs;

-- Recreate every benchmark_runs index dropped with the old table.
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_time ON benchmark_runs(model_id, started_at);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started ON benchmark_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started_type ON benchmark_runs(started_at, benchmark_type);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_started_type ON benchmark_runs(model_id, started_at, benchmark_type);
CREATE INDEX IF NOT EXISTS idx_runs_itl ON benchmark_runs(started_at, itl_ms);
CREATE INDEX IF NOT EXISTS idx_runs_failures
  ON benchmark_runs (started_at, provider, status, model)
  WHERE status != 'SUCCESS';

-- Speed-probe workload seed (TokenDyno-identical prompt + 300-token cap).
INSERT OR IGNORE INTO benchmark_config (key, value, updated_at) VALUES
  ('benchmark.speed.prompt', 'Write a 400-word prose explanation of HTTP request routing. Plain text only.', datetime('now')),
  ('benchmark.speed.max_tokens', '300', datetime('now')),
  ('methodology.hybrid_tps', 'inter-token when >=8 chunks mean gap >50ms else wall-clock; TTFT excluded in both paths', datetime('now'));
