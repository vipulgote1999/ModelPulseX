-- 0019_login_attempts_cleanup.sql — make the stale-bucket prune indexed.
--
-- cleanupRetention now deletes login_attempts older than the 15-minute
-- throttle window by last_attempt_at. Rows that never crossed the attempt cap
-- have blocked_until NULL, so the previous blocked-only predicate never
-- removed them. Additive index only; safe to apply independently of the code.

CREATE INDEX IF NOT EXISTS idx_login_attempts_last ON login_attempts(last_attempt_at);
