-- 0007_admin_benchmark_toggle.sql — per-model benchmark enable/disable for admin panel
-- Keeps ALL discovered models (never deletes) but lets admin toggle benchmarking per model.
-- Scheduler will only queue models where benchmark_enabled=1 AND active=1 AND free_status='FREE' or UNKNOWN-but-enabled.
-- Also adds admin_sessions helper via benchmark_config for HMAC secret rotation (optional).

-- Add toggle column to models (0=disabled, 1=enabled). Default 1 for existing rows; discovery will set correct default on insert.
ALTER TABLE models ADD COLUMN benchmark_enabled INTEGER NOT NULL DEFAULT 1;

-- Index for scheduler hot path: active + benchmark_enabled + free_status
CREATE INDEX IF NOT EXISTS idx_models_benchmark_enabled ON models (
    benchmark_enabled, active, free_status
);
CREATE INDEX IF NOT EXISTS idx_models_provider_benchmark ON models (
    provider_id, benchmark_enabled
);

-- Seed benchmark_enabled for existing rows based on verified-free allowlists.
-- Providers with only $1 credit trial default DISABLED (admin can re-enable when they go free again).
-- Paid groq variants disabled; only true free groq ids stay enabled.

-- Disable speka / nexaapi / ninerouter entirely by default (they are $1 credit / router, not $0)
UPDATE models SET benchmark_enabled = 0
WHERE provider_id IN (
    SELECT id FROM providers
    WHERE name IN ('speka', 'nexaapi', 'ninerouter')
);

-- Disable groq models that are NOT in the 7 true chat-free allowlist (others are paid now)
-- Allowlist: qwen/qwen3.6-27b, minimaxai/minimax-m2.7, groq/compound, groq/compound-mini, moonshotai/kimi-k2-instruct, openai/gpt-oss-120b, openai/gpt-oss-20b, openai/gpt-oss-safeguard-20b
UPDATE
    models
SET benchmark_enabled = 0
WHERE provider_id IN (
    SELECT id FROM providers
    WHERE name = 'groq'
)
AND provider_model_id NOT IN ('qwen/qwen3.6-27b', 'minimaxai/minimax-m2.7', 'groq/compound', 'groq/compound-mini', 'moonshotai/kimi-k2-instruct', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-safeguard-20b', 'whisper-large-v3', 'whisper-large-v3-turbo');

-- Disable whisper audio models from benchmark even if allowlisted (not chat-benchmarkable)
UPDATE models SET benchmark_enabled = 0
WHERE provider_model_id IN ('whisper-large-v3', 'whisper-large-v3-turbo');

-- Ensure verified free providers default ENABLED (idempotent)
UPDATE models SET benchmark_enabled = 1
WHERE provider_id IN (
    SELECT id FROM providers
    WHERE
        name IN (
            'opencode_zen',
            'openrouter',
            'tokenrouter',
            'ollama',
            'glhf',
            'kilocode',
            'orcarouter',
            'agnes_ai',
            'aionlabs',
            'nscale',
            'sambanova',
            'gemini',
            'mistral',
            'cerebras',
            'nvidia'
        )
) AND benchmark_enabled IS NULL;

-- Admin credentials are stored as wrangler secrets: ADMIN_ID / ADMIN_PASSWORD / ADMIN_TOKEN (legacy).
-- No D1 table needed for auth — token is stateless HMAC issued by /api/admin/login. This migration only adds model toggle.
