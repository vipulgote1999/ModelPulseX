-- 0009_security.sql — security hardening: audit log and enhanced rate-limit persistence
-- Audit log for admin actions (immutable append-only; never stores secrets)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_fingerprint TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  target TEXT,
  details TEXT, -- JSON, sanitized
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

-- Optional persistent rate limit bucket (for cross-isolate brute-force protection on login)
-- Worker in-memory limits are primary; this table gives cross-edge fallback for login brute force
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  blocked_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_blocked ON login_attempts(blocked_until);

-- Security notes:
-- - audit_log never stores raw ADMIN_TOKEN, passwords, or API keys; only fingerprints
-- - login_attempts is pruned by retention cleanup (30d)
-- - Both tables are append-only/write-throttled; reads are indexed
