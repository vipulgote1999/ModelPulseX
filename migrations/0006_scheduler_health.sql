-- 0006: scheduler observability + one-shot data-fix guard.
-- scheduler_health is a singleton row (id=1) updated by every cron tick so
-- enqueue health (last_schedule_at / counts) is observable via API instead of
-- silently failing.
CREATE TABLE IF NOT EXISTS scheduler_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_schedule_at TEXT,
  last_enqueue_count INTEGER DEFAULT 0,
  last_inline_count INTEGER DEFAULT 0,
  last_skipped_cooldown INTEGER DEFAULT 0,
  last_skipped_rpm INTEGER DEFAULT 0,
  last_discovery_at TEXT,
  last_aggregate_at TEXT,
  last_stale_alert_at TEXT,
  updated_at TEXT
);
INSERT OR IGNORE INTO scheduler_health (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z');

-- Versioned one-shot data fixes: replaces hardcoded cleanups that previously ran on
-- every discovery cycle (violated the no-hardcode convention and risked deleting
-- legitimately-free models). Each fix_id is applied exactly once.
CREATE TABLE IF NOT EXISTS data_fixes (
  fix_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
