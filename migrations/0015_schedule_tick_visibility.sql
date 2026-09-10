-- 0015_schedule_tick_visibility.sql — make a slow or killed scheduler tick visible (issue #26).
--
-- Why: the */5 tick runs up to BENCH_INLINE_FALLBACK (6) benchmark jobs inline and only
-- writes its heartbeat at the END. The coding workload allows a 300s provider timeout per
-- job, so a tick can overrun the 5-minute cron interval: `/api/health` then reports a frozen
-- `last_schedule_at` while benchmarks are still finishing, and overlapping ticks starve
-- scheduling. Observed 2026-09-10: last_schedule_at frozen at 13:06 while last_benchmark
-- advanced to 13:55, and runs/10min collapsing from ~26 to 1-2.
--
-- `last_schedule_started_at` is stamped before any work, so a tick in flight is visible even
-- if it is later killed; `last_schedule_ms` records how long the last completed tick took.
ALTER TABLE scheduler_health ADD COLUMN last_schedule_started_at TEXT;
ALTER TABLE scheduler_health ADD COLUMN last_schedule_ms INTEGER;
