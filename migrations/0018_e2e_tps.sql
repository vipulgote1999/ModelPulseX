-- 0018_e2e_tps.sql — end-to-end throughput (whole request, includes TTFT).
--
-- e2e_tps = output_tokens / ((completed_at - started_at) / 1000), rounded to 2
-- decimals. This is the ranked throughput metric. Decode TPS (`tps`) keeps its
-- generation-window meaning and is diagnostic only. Never write e2e_tps into
-- `tps`. No floor and no clamp: unmeasurable rows stay NULL.
--
-- Additive only: no table rebuilds, no CHECK changes, no new indexes.

ALTER TABLE benchmark_runs ADD COLUMN e2e_tps REAL;

UPDATE benchmark_runs
SET e2e_tps = ROUND(
  output_tokens * 1000.0 /
  ((julianday(completed_at) - julianday(started_at)) * 86400000.0), 2)
WHERE status = 'SUCCESS'
  AND output_tokens > 0
  AND started_at IS NOT NULL
  AND completed_at IS NOT NULL
  AND julianday(completed_at) > julianday(started_at);

ALTER TABLE hourly_model_stats ADD COLUMN median_e2e_tps REAL;
ALTER TABLE tenmin_model_stats ADD COLUMN median_e2e_tps REAL;

ALTER TABLE leaderboard_snapshot ADD COLUMN e2e_tps_1h REAL;
ALTER TABLE leaderboard_snapshot ADD COLUMN e2e_tps_24h REAL;
ALTER TABLE leaderboard_snapshot ADD COLUMN e2e_tps_7d REAL;
ALTER TABLE leaderboard_snapshot ADD COLUMN median_chunks_7d REAL;
