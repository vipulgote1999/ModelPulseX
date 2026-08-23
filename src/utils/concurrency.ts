/** Concurrency caps and jittered backoff — pure helpers. */

export interface ConcurrencyConfig {
  maxGlobal: number;
  maxOpencode: number;
  maxOpenrouter: number;
  maxSameModel: number;
}

export function getConcurrency(env: Record<string, unknown>): ConcurrencyConfig {
  return {
    maxGlobal: Number(env.MAX_GLOBAL_CONCURRENCY) || 10,
    maxOpencode: Number(env.MAX_OPENCODE_CONCURRENCY) || 3,
    maxOpenrouter: Number(env.MAX_OPENROUTER_CONCURRENCY) || 5,
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
