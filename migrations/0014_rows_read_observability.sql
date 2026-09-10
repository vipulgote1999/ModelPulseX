-- 0014_rows_read_observability.sql — daily rows-read accounting (issue #12).
--
-- Why: the 2026-09-05/09 free-tier breach (5M rows/day) was invisible from inside the
-- Worker — the only signal was the Cloudflare dashboard. D1 returns `meta.rows_read` per
-- statement, so the */5 scheduler tick now accumulates the measured cost of the queries
-- that caused the breach into one row per UTC day.
--
-- Honesty: only MEASURED shapes are counted, so this is a lower bound on true account
-- consumption (the API field is named `rows_read_measured_today`). One row per day keeps
-- this table tiny and bounded; it is not a per-query log.
CREATE TABLE IF NOT EXISTS rows_read_daily (
    day TEXT PRIMARY KEY,          -- UTC YYYY-MM-DD
    rows_read INTEGER NOT NULL DEFAULT 0,
    top_shape TEXT,                -- highest single measured shape today
    top_rows INTEGER,
    -- set once when the budget threshold was crossed
    alerted_at TEXT,
    updated_at TEXT NOT NULL
);
