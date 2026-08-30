/** In-memory sliding window rate limiter for Workers.
 *  Workers isolates have per-isolate memory, so this is best-effort per-edge.
 *  For stronger global limiting, front with Cloudflare Rate Limiting Rules.
 *  Keys are typically client IP + route. Window is sliding via timestamp queue.
 */

export interface RateLimitOpts {
  windowMs: number;
  max: number;
}

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();
// Periodic cleanup to avoid unbounded growth (every 5m sweep)
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < 5 * 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    b.timestamps = b.timestamps.filter((t) => now - t < 60 * 60_000);
    if (b.timestamps.length === 0) buckets.delete(k);
  }
}

export function checkRateLimit(key: string, opts: RateLimitOpts): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  sweep(now);
  let b = buckets.get(key);
  if (!b) {
    b = { timestamps: [] };
    buckets.set(key, b);
  }
  // purge window
  b.timestamps = b.timestamps.filter((t) => now - t < opts.windowMs);
  if (b.timestamps.length >= opts.max) {
    const oldest = b.timestamps[0] ?? now;
    const resetMs = oldest + opts.windowMs - now;
    return { allowed: false, remaining: 0, resetMs: Math.max(0, resetMs) };
  }
  b.timestamps.push(now);
  return { allowed: true, remaining: opts.max - b.timestamps.length, resetMs: opts.windowMs };
}

/** Extract client IP best-effort from Cloudflare headers. */
export function getClientIp(req: Request): string {
  // Cloudflare sets cf-connecting-ip; fallback to x-forwarded-for / x-real-ip
  const h = req.headers;
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim().split(",")[0]!.trim();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const xr = h.get("x-real-ip");
  if (xr) return xr.trim();
  return "unknown";
}

/** Build a rate-limit key from IP + route prefix. */
export function rateKey(ip: string, scope: string): string {
  return `${scope}:${ip}`;
}
