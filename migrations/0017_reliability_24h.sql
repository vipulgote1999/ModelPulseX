-- 0017_reliability_24h.sql — e04s03: 24h reliability (TokenDyno successRate24h parity).
-- The snapshot carried 7d uptime plus a 24h sample count but no 24h success
-- rate. This adds the precomputed column; the hourly writer fills it from
-- ok_24h/tot_24h in the same raw pass (gated MIN_SAMPLES.w24h like uptime_7d).
-- Additive nullable column: safe to leave applied on code revert. Readers
-- tolerate its absence (snapshot SELECT lists columns explicitly; a missing
-- column throws inside refreshLeaderboardSnapshot's try/catch warn-and-skip,
-- and the API live-query fallback serves rows without it).

ALTER TABLE leaderboard_snapshot ADD COLUMN uptime_24h REAL;
