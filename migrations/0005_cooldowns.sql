-- 0005_cooldowns.sql — per-model vs per-provider cooldowns and RPM tracking

-- Provider-level cooldown (RATE_LIMITED etc): when provider refuses, timeout is provider-wide
CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider TEXT PRIMARY KEY,
  cooldown_until TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL
);

-- Model-level cooldown (MODEL_UNAVAILABLE, TIMEOUT, model-specific PROVIDER_ERROR)
CREATE TABLE IF NOT EXISTS model_cooldowns (
  model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  cooldown_until TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_model_cooldowns_until ON model_cooldowns(cooldown_until);
CREATE INDEX IF NOT EXISTS idx_provider_cooldowns_until ON provider_cooldowns(cooldown_until);

-- Cleanup old cooldowns eventually (retention not needed, but keep for debugging 30d)
-- No daily job needed; cooldown rows are overwritten on new cooldown, expired ones are ignored via WHERE cooldown_until > now
