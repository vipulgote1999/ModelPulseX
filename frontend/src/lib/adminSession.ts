/** Admin auth client.
 *
 *  SEC-001: the admin token is no longer held in JavaScript. `POST
 *  /api/admin/login` returns it in an `HttpOnly` cookie, which no script on
 *  the page can read, plus a separate CSRF token that is deliberately
 *  JS-readable (it is useless without the HttpOnly session cookie). Every
 *  authenticated call therefore relies on the browser's own cookie jar —
 *  `fetch` sends the session cookie for same-origin requests automatically —
 *  and only the CSRF token is attached as a header.
 *
 *  This removes the entire class of "script steals the token" attacks: there
 *  is no token in a storage API, no token in a variable an injected script
 *  can reach after the fact, and no token in localStorage that a browser
 *  extension can read at rest.
 *
 *  The CSRF token is kept in memory only (module scope, not storage) so it
 *  does not outlive the tab.
 */

let csrfToken: string | null = null;

export function setCsrfToken(t: string | null): void {
  csrfToken = t;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** Headers for an authenticated admin request. The session cookie rides along
 *  automatically; we only add the CSRF double-submit header. */
export function adminHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (csrfToken) h["X-CSRF-Token"] = csrfToken;
  return h;
}

/** `fetch` options for a state-changing admin request.
 *
 *  `same-origin` credentials is the default for same-origin URLs but is set
 *  explicitly so the intent survives a refactor. */
export function adminRequest(init: RequestInit = {}): RequestInit {
  const headers = adminHeaders(
    (init.headers as Record<string, string>) ?? {},
  );
  return { ...init, headers, credentials: "same-origin" };
}

/** A previously-persisted token (pre-SEC-001 upgrade) must be purged, or it
 *  would sit readable in localStorage forever with no way to notice. */
export function purgeLegacyToken(): void {
  try {
    localStorage.removeItem("modelpulsex_admin_token");
  } catch {
    // private mode / storage disabled — nothing to purge
  }
}
