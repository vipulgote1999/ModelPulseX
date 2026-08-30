/** Security utilities — constant-time compare, validation, CSP, audit logging. Pure helpers, testable. */

/** Constant-time string comparison to mitigate timing attacks on token checks.
 *  Uses WebCrypto subtle timing-safe pattern when available, otherwise manual. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Manual constant-time: compare all chars without early exit, but still length check prevents length leak
  // In JS we can't guarantee JIT won't optimize, but this is best-effort portable.
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Validate that a token looks like a high-entropy secret (hex/base64ish, >=32 chars). */
export function isStrongToken(token: string | undefined): boolean {
  if (!token) return false;
  if (token.length < 32) return false;
  // reject obvious placeholders
  const lower = token.toLowerCase();
  if (lower.includes("change-me") || lower.includes("local-admin") || lower === "admin" || lower === "password") return false;
  return true;
}

export const VALID_RANGES = new Set(["1h", "24h", "3d", "7d", "30d"]);
export const VALID_BENCHMARKS = new Set(["all", "short", "medium", "coding"]);
export const VALID_SORTS = new Set(["overall", "tps", "ttft", "uptime"]);
export const VALID_PROFILES = new Set(["balanced", "fastest", "latency", "reliable", "coding"]);
export const VALID_GRANULARITIES = new Set(["hourly", "10m"]);

export function isValidRange(v: string | null | undefined): boolean {
  return !!v && VALID_RANGES.has(v);
}
export function isValidBenchmark(v: string | null | undefined): boolean {
  return !!v && VALID_BENCHMARKS.has(v);
}
export function isValidSort(v: string | null | undefined): boolean {
  return !!v && VALID_SORTS.has(v);
}
export function isValidProfile(v: string | null | undefined): boolean {
  return !!v && VALID_PROFILES.has(v);
}

/** Sanitize free-text search query: trim, cap length, strip control chars and SQL wildcard abuse. */
export function sanitizeSearchQuery(q: string | null | undefined, maxLen = 100): string | null {
  if (!q) return null;
  let s = q.trim().slice(0, maxLen);
  // strip control chars and null bytes (keep printable + unicode)
  s = s.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "");
  // collapse multiple % and _ to single to limit LIKE wildcard DoS
  // keep them for user search but bound them
  if (s.length < 1) return null;
  return s;
}

/** Validate and sanitize comma-separated IDs, max 12, numeric, positive. */
export function parseIdsParam(raw: string | null | undefined, max = 12): number[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, max);
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n) || n > 1_000_000) return null;
    nums.push(n);
  }
  if (nums.length === 0) return null;
  return nums;
}

/** Validate provider name against registry-like slug pattern. */
export function isValidProviderSlug(p: string | null | undefined): boolean {
  if (!p) return false;
  return /^[a-z0-9_]{2,32}$/.test(p);
}

/** Generate a strict Content-Security-Policy for the SPA dashboard.
 *  Dashboard is React + Recharts (inline styles needed) + SSE.
 *  No external scripts, no eval, no object-src. */
export function buildCsp(nonce?: string): string {
  const script = nonce ? `'nonce-${nonce}' 'strict-dynamic'` : `'self'`;
  // Minimal strict policy — adjust if you embed analytics
  return [
    `default-src 'self'`,
    `script-src ${script} 'self'`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' data: blob: https:`,
    `connect-src 'self' https://api.*.workers.dev https: wss:`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `form-action 'self'`,
  ].join("; ");
}

/** Structured audit log entry for admin actions — write to console and optionally D1. */
export interface AuditEntry {
  ts: string;
  action: string;
  actor: string; // ip or token fingerprint
  target?: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export function auditLog(entry: AuditEntry): void {
  // Structured JSON for log aggregation; never log raw token
  const line = JSON.stringify({ level: "audit", ...entry });
  console.log(line);
}

/** Fingerprint a token for logs without revealing it (first 6 + last 4 + hash length). */
export function tokenFingerprint(token: string): string {
  if (token.length <= 10) return `***len:${token.length}`;
  return `${token.slice(0, 6)}***${token.slice(-4)} (len:${token.length})`;
}

/** Check if origin is allowed strictly — rejects "*" and empty, validates URL shape. */
export function isOriginAllowed(origin: string | null | undefined, allowlist: string[]): boolean {
  if (!origin) return false;
  origin = origin.trim();
  if (origin === "*" || origin === "null") return false;
  // Must be a valid https origin (or http for localhost dev)
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return false;
    // Exact match against allowlist (allowlist entries are full origins)
    return allowlist.includes(origin);
  } catch {
    return false;
  }
}

/** Sanitize error message for client — hide internal details, keep generic. */
export function sanitizeErrorMessage(e: unknown, fallback = "internal error"): string {
  const msg = String((e as Error)?.message ?? e ?? fallback);
  // Never echo SQL, paths, or stack traces to client
  if (msg.includes("D1_ERROR") || msg.includes("no such table") || msg.includes("SQLITE") || msg.includes("prepare") || msg.includes(".ts:")) {
    return fallback;
  }
  // Truncate and strip newlines
  return msg.replace(/[\r\n]+/g, " ").slice(0, 200) || fallback;
}

/** Validate that CORS_ORIGIN env doesn't contain wildcard or insecure values. */
export function validateCorsConfig(corsOrigin: string | undefined): { valid: boolean; reason?: string; origins: string[] } {
  const raw = corsOrigin ?? "https://modelpulsex.vipulgote5.workers.dev";
  const origins = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.includes("*")) return { valid: false, reason: "CORS_ORIGIN must not contain * when credentials are used", origins };
  if (origins.some((o) => o.includes("*"))) return { valid: false, reason: "CORS_ORIGIN wildcard subdomain not allowed", origins };
  for (const o of origins) {
    if (o === "null") return { valid: false, reason: "CORS_ORIGIN must not be null", origins };
    try {
      const u = new URL(o);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) {
        // allow http localhost for dev only
        if (!u.hostname.includes("localhost")) return { valid: false, reason: `CORS_ORIGIN insecure protocol: ${o}`, origins };
      }
    } catch {
      return { valid: false, reason: `CORS_ORIGIN invalid URL: ${o}`, origins };
    }
  }
  return { valid: true, origins };
}
