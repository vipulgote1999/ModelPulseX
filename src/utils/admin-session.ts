/** Admin session cookies and CSRF tokens.
 *
 *  **Why this exists (SEC-001).** The admin bearer token used to live in
 *  `localStorage`, which any injected script, any browser extension, and any
 *  local process reading the browser profile could read — and which never
 *  expired. Possession of that token is full admin control: read all data,
 *  toggle any model, force benchmarks, spend provider credits.
 *
 *  The fix has two halves:
 *
 *  1. `HttpOnly` on the session cookie removes the token from JavaScript
 *     reach entirely. SameSite=Strict stops the browser sending it on any
 *     cross-site request, and `Secure` keeps it off plaintext transport.
 *
 *  2. A CSRF double-submit token. SameSite=Strict already blocks the classic
 *     cross-site form/fetch CSRF for this cookie, but it is a single browser
 *     behaviour standing between us and every write endpoint, and it is
 *     scoped by path/creation heuristics we do not control. Requiring a
 *     second value — readable by JS, echoed in a custom header — means an
 *     attacker's cross-origin script must both read a cookie value (it cannot,
 *     same-origin policy) and set a custom header (which triggers a CORS
 *     preflight our origin allowlist fails). Two independent barriers instead
 *     of one.
 *
 *  Pure helpers only — no Cloudflare imports, so this is unit-testable.
 */

export const SESSION_COOKIE = "mpx_session";
export const CSRF_COOKIE = "mpx_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** 12h. Long enough for a work session, short enough that an abandoned
 *  browser does not keep a valid admin session for days. */
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

/** Cookie flags. HttpOnly + Secure + SameSite=Strict is the whole point —
 *  do not relax any of the three without re-reading this comment. */
export const SESSION_COOKIE_ATTRS =
  "HttpOnly; Secure; SameSite=Strict; Path=/";
export const CSRF_COOKIE_ATTRS = "Secure; SameSite=Strict; Path=/";

/** Methods that do not change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfRequired(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** Cryptographically random token, hex-encoded. Uses WebCrypto, available in
 *  Workers and in Node 18+ (so tests run unmodified). */
export function randomToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare for two hex tokens. */
export function tokensMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

/** Parse a Cookie header into a map. Tolerates malformed input. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Serialize a Set-Cookie value. */
export function buildSetCookie(
  name: string,
  value: string,
  attrs: string,
  maxAgeS?: number,
): string {
  const maxAge = typeof maxAgeS === "number" ? ` Max-Age=${Math.max(0, Math.floor(maxAgeS))}` : "";
  return `${name}=${encodeURIComponent(value)}; ${attrs}${maxAge}`;
}

/** Expire a cookie immediately. Both auth cookies must use the same
 *  Path/SameSite as when they were set or the browser keeps the original. */
export function buildClearCookie(name: string, httpOnly: boolean): string {
  const flags = [
    httpOnly ? "HttpOnly" : "",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
  return `${name}=; ${flags}`;
}
