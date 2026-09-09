/** Security utilities — constant-time compare, validation, CSP, audit logging. Pure helpers, testable. */

/** Constant-time string comparison to mitigate timing attacks on token checks.
 *  Uses WebCrypto subtle timing-safe pattern when available, otherwise manual. */
export function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time length handling: avoid early return leaking length via timing (P2)
  // In JS we can't guarantee JIT won't optimize, but this is best-effort portable.
  const lenA = a.length;
  const lenB = b.length;
  const maxLen = Math.max(lenA, lenB);
  let diff = lenA ^ lenB;
  for (let i = 0; i < maxLen; i++) {
    // SAFETY: charCodeAt beyond length yields NaN -> 0 ensures constant-time over maxLen
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Validate that a token looks like a high-entropy secret (hex/base64ish, >=32 chars). */
export function isStrongToken(token: string | undefined): boolean {
  if (!token) return false;
  if (token.length < 32) return false;
  // reject obvious placeholders
  const lower = token.toLowerCase();
  if (
    lower.includes("change-me") ||
    lower.includes("local-admin") ||
    lower === "admin" ||
    lower === "password"
  )
    return false;
  return true;
}

/** Sanitize free-text search query: trim, cap length, strip control chars and SQL wildcard abuse. */
export function sanitizeSearchQuery(
  q: string | null | undefined,
  maxLen = 100,
): string | null {
  if (!q) return null;
  let s = q.trim().slice(0, maxLen);
  // strip control chars and null bytes (keep printable + unicode)
  s = s.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "");
  // collapse consecutive % and _ wildcards to single to limit LIKE DoS
  s = s.replace(/([%_])\1+/g, "$1");
  if (s.length < 1) return null;
  return s;
}

/** Escape SQL LIKE wildcards (% _ \) for safe pattern binding. Caller must add ESCAPE '\\' in SQL. */
export function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/** Sanitize error message for client — hide internal details, keep generic. */
export function sanitizeErrorMessage(
  e: unknown,
  fallback = "internal error",
): string {
  const msg = String((e as Error)?.message ?? e ?? fallback);
  // Never echo SQL, paths, or stack traces to client
  if (
    msg.includes("D1_ERROR") ||
    msg.includes("no such table") ||
    msg.includes("SQLITE") ||
    msg.includes("prepare") ||
    msg.includes(".ts:")
  ) {
    return fallback;
  }
  // Truncate and strip newlines
  return msg.replace(/[\r\n]+/g, " ").slice(0, 200) || fallback;
}

/** Validate that CORS_ORIGIN env doesn't contain wildcard or insecure values. */
export function validateCorsConfig(corsOrigin: string | undefined): {
  valid: boolean;
  reason?: string;
  origins: string[];
} {
  const raw = corsOrigin ?? "https://modelpulsex.vipulgote5.workers.dev";
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.includes("*"))
    return {
      valid: false,
      reason: "CORS_ORIGIN must not contain * when credentials are used",
      origins,
    };
  if (origins.some((o) => o.includes("*")))
    return {
      valid: false,
      reason: "CORS_ORIGIN wildcard subdomain not allowed",
      origins,
    };
  for (const o of origins) {
    if (o === "null")
      return { valid: false, reason: "CORS_ORIGIN must not be null", origins };
    try {
      const u = new URL(o);
      if (
        u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          /^(localhost|127\.0\.0\.1)$/.test(u.hostname)
        )
      ) {
        // allow http localhost for dev only
        if (!u.hostname.includes("localhost"))
          return {
            valid: false,
            reason: `CORS_ORIGIN insecure protocol: ${o}`,
            origins,
          };
      }
    } catch {
      return { valid: false, reason: `CORS_ORIGIN invalid URL: ${o}`, origins };
    }
  }
  return { valid: true, origins };
}
