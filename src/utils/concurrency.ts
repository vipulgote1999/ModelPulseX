/** Concurrency caps and jittered backoff — pure helpers. */

export interface ConcurrencyConfig {
  maxGlobal: number;
  maxOpencode: number;
  maxOpenrouter: number;
  maxGroq: number;
  maxCerebras: number;
  maxGemini: number;
  maxNvidia: number;
  maxSambanova: number;
  maxMistral: number;
  maxAgnesAi: number;
  maxAionlabs: number;
  maxKilocode: number;
  maxGlhf: number;
  maxNscale: number;
  maxSpeka: number;
  maxNexaapi: number;
  maxOrcarouter: number;
  maxNinerouter: number;
  maxTokenrouter: number;
  maxSameModel: number;
}

export function getConcurrency(env: Record<string, unknown>): ConcurrencyConfig {
  return {
    maxGlobal: Number(env.MAX_GLOBAL_CONCURRENCY) || 16,
    maxOpencode: Number(env.MAX_OPENCODE_CONCURRENCY) || 3,
    maxOpenrouter: Number(env.MAX_OPENROUTER_CONCURRENCY) || 4,
    maxGroq: Number(env.MAX_GROQ_CONCURRENCY) || 3,
    maxCerebras: Number(env.MAX_CEREBRAS_CONCURRENCY) || 2,
    maxGemini: Number(env.MAX_GEMINI_CONCURRENCY) || 3,
    maxNvidia: Number(env.MAX_NVIDIA_CONCURRENCY) || 2,
    maxSambanova: Number(env.MAX_SAMBANOVA_CONCURRENCY) || 2,
    maxMistral: Number(env.MAX_MISTRAL_CONCURRENCY) || 2,
    maxAgnesAi: Number(env.MAX_AGNES_AI_CONCURRENCY) || 2,
    maxAionlabs: Number(env.MAX_AIONLABS_CONCURRENCY) || 2,
    maxKilocode: Number(env.MAX_KILOCODE_CONCURRENCY) || 2,
    maxGlhf: Number(env.MAX_GLHF_CONCURRENCY) || 2,
    maxNscale: Number(env.MAX_NSCALE_CONCURRENCY) || 2,
    maxSpeka: Number(env.MAX_SPEKA_CONCURRENCY) || 2,
    maxNexaapi: Number(env.MAX_NEXAAPI_CONCURRENCY) || 2,
    maxOrcarouter: Number(env.MAX_ORCAROUTER_CONCURRENCY) || 2,
    maxNinerouter: Number(env.MAX_NINEROUTER_CONCURRENCY) || 2,
    maxTokenrouter: Number(env.MAX_TOKENROUTER_CONCURRENCY) || 3,
    maxSameModel: Number(env.MAX_SAME_MODEL_CONCURRENCY) || 1,
  };
}

export function jittered(base: number): number {
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.min(86400, Math.round(base * jitter)));
}

export function backoff(attempt: number, base = 1000): number {
  const exp = Math.min(4, attempt);
  return jittered(base * Math.pow(2, exp));
}

export function retryAfterSeconds(res: Response): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (!Number.isNaN(secs)) return Math.max(1, Math.min(3600, secs));
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(1, Math.min(3600, Math.round((d - Date.now()) / 1000)));
  }
  const reset = res.headers.get("x-ratelimit-reset") || res.headers.get("x-rate-limit-reset");
  if (reset) {
    const n = Number(reset);
    if (!Number.isNaN(n)) {
      if (n > 1e12) return Math.max(1, Math.round((n - Date.now()) / 1000));
      if (n > 1e9) return Math.max(1, Math.round(n - Date.now() / 1000));
      return Math.max(1, n);
    }
  }
  return jittered(60);
}
