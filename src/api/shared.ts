import type { Env } from "../types";
import { timingSafeEqual } from "../utils/security";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  csrfRequired,
  parseCookies,
  tokensMatch,
} from "../utils/admin-session";

/** ISO cutoff for time-window SQL — SQLite datetime('now',…) emits space-separated
 *  timestamps that string-compares BELOW ISO-'T' columns, silently widening every window
 *  to "since UTC midnight". Always compute cutoffs in JS and bind them instead. */
export const isoHoursAgo = (h: number): string =>
  new Date(Date.now() - h * 3600_000).toISOString();

/** Extract the admin bearer from an Authorization header, or null.
 *
 *  SEC-005: the `Bearer ` prefix is now REQUIRED. The previous code also
 *  accepted the bare token (`Authorization: <token>`) and an `x-admin-token`
 *  header. Both leak far more readily than a standard Authorization header —
 *  a bare token is not recognised as a credential by most intermediaries, so
 *  it survives in proxy/access logs, log shippers, and error echoes that
 *  redact only `Authorization`. Bearer remains supported for curl/CI, which
 *  has no cookie jar. */
export function bearerToken(
  auth: string | null | undefined,
): string | null {
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}

/** Read the session cookie value from a request's Cookie header. */
export function sessionCookie(req: {
  header(n: string): string | undefined;
}): string | null {
  return parseCookies(req.header("cookie"))[SESSION_COOKIE] ?? null;
}

export function isAdmin(
  c: { req: { header(n: string): string | undefined } },
  env: Env,
): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  // Cookie first (the browser path — the token is HttpOnly so JS never sees it),
  // then the Bearer header for curl/CI automation.
  const cookie = sessionCookie(c.req);
  if (cookie && timingSafeEqual(cookie, token)) return true;
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer && timingSafeEqual(bearer, token)) return true;
  return false;
}

/** CSRF double-submit check for state-changing admin requests.
 *
 *  Must run only AFTER the caller has established that the request is
 *  authenticated: an unauthenticated cross-site POST has no session cookie
 *  to echo, so CSRF is the second barrier, not the first.
 *
 *  Accepts the token from the `X-CSRF-Token` header (what our own client
 *  sends) or the `csrf` form/body field, and compares it against the
 *  `mpx_csrf` cookie. A cross-origin attacker can satisfy neither side:
 *  reading the cookie is blocked by the same-origin policy, and setting a
 *  custom header triggers a preflight that the CORS allowlist rejects. */
export function csrfOk(c: {
  req: { header(n: string): string | undefined; method?: string };
  method?: string;
}): boolean {
  const method = c.method ?? c.req.method ?? "GET";
  if (!csrfRequired(method)) return true;
  const cookies = parseCookies(c.req.header("cookie"));
  const expected = cookies[CSRF_COOKIE];
  if (!expected) return false;
  const supplied = c.req.header(CSRF_HEADER) ?? c.req.header("x-csrf") ?? null;
  return tokensMatch(supplied, expected);
}
