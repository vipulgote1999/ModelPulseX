-- 0012_snapshot.sql — precomputed leaderboard snapshot + per-run latest overlay.
-- Goal: cut /api/leaderboard per-hit reads from ~9-15k rows to ~600 rows so the
-- 5M/day free-tier cap survives real traffic. The hourly cron refreshes the
-- snapshot (fixed cost); readers serve it with a live-query fallback.
-- Snapshot medians are exact raw medians (GROUP_CONCAT → P50 in JS) with the
-- same min-sample gates; the live path averages hourly medians instead, so
-- values can differ within noise after cutover. Methodology documents this.

-- Latest-run overlay as JSON per benchmark type: stamped by insertBenchmarkRun
-- via json_patch in the same UPDATE as last_benchmark_at (zero extra round
-- trips). Shape: {"short":{"tps":..,"ttft":..,"itl":..,"status":"..","at":".."},...}.
-- Lets the snapshot reader serve fresh tps_now/status without scanning runs.
ALTER TABLE models ADD COLUMN last_now_json TEXT;

-- One row per (benchmark, model): final display-ready windowed medians.
-- Range is NOT part of the key: leaderboard numbers are range-independent
-- (range only affects charts/meta); tps_1h/24h/7d are always computed.
CREATE TABLE IF NOT EXISTS leaderboard_snapshot (
    benchmark TEXT NOT NULL,
    model_id INTEGER NOT NULL REFERENCES models (id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_model_id TEXT NOT NULL,
    free_status TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    tps_1h REAL,
    tps_24h REAL,
    tps_7d REAL,
    ttft_1h REAL,
    ttft_24h REAL,
    ttft_7d REAL,
    itl_7d REAL,
    uptime_7d REAL,
    error_rate_7d REAL,
    sparkline TEXT,
    sample_count_24h INTEGER,
    request_count_7d INTEGER,
    snapshot_at TEXT NOT NULL,
    PRIMARY KEY (benchmark, model_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_benchmark ON leaderboard_snapshot (
    benchmark
);
