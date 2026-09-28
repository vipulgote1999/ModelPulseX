/** SEC-001 + SEC-005 + SEC-006: admin session cookies, CSRF, and auth hardening.
 *
 *  These are the regression tests for the change that moved the admin bearer
 *  token out of `localStorage` and into an HttpOnly cookie. The specific
 *  failures they lock down:
 *  - token must never appear in a response body
 *  - the session cookie must be HttpOnly + Secure + SameSite=Strict
 *  - a state-changing admin request with a session cookie but no CSRF header
 *    must be refused (the double-submit barrier)
 *  - a weak ADMIN_TOKEN must not be issued (fail closed, not warn)
 *  - bare-token Authorization and x-admin-token must no longer authenticate
 */
import { describe, expect, it } from "vitest";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  buildClearCookie,
  buildSetCookie,
  csrfRequired,
  parseCookies,
  randomToken,
  tokensMatch,
} from "../src/utils/admin-session";
import { bearerToken, csrfOk, isAdmin } from "../src/api/shared";
import { createApi } from "../src/api/routes";

const STRONG_TOKEN = "a".repeat(40); // >= 32 chars -> passes isStrongToken

function env(over: Record<string, unknown> = {}) {
  return {
    ADMIN_TOKEN: STRONG_TOKEN,
    ADMIN_ID: "admin",
    ADMIN_PASSWORD: "correct-horse-battery",
    DB: fakeDb(),
    ...over,
  } as never;
}

/** Minimal D1 stub: audit INSERTs are counted so we can assert on write
 *  amplification, and login_attempts reads/writes are recorded. */
function fakeDb() {
  // Counters live in a nested object and are exposed via getters, because
  // Object.assign copies primitive values — a `db.auditInserts++` on a copied
  // primitive would increment a detached copy and always read back as 0.
  const counters = { auditInserts: 0 };
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => null,
            run: async () => {
              if (/INSERT INTO audit_log/i.test(sql)) counters.auditInserts++;
              return { meta: { changes: 1 } };
            },
            all: async () => ({ results: [] }),
          };
        },
        first: async () => null,
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
      };
    },
    batch: async () => [],
  };
  return Object.defineProperty(db, "auditInserts", {
    get: () => counters.auditInserts,
  }) as typeof db & { auditInserts: number };
}

const jsonReq = (path: string, init: RequestInit = {}) =>
  new Request(`https://example.test${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("cookie parsing / building", () => {
  it("parses a cookie header into a map", () => {
    const c = parseCookies("mpx_session=abc; mpx_csrf=def; other=1");
    expect(c.mpx_session).toBe("abc");
    expect(c.mpx_csrf).toBe("def");
  });

  it("tolerates a missing or malformed header", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("nonsense")).toEqual({});
  });

  it("decodes percent-encoded values", () => {
    expect(parseCookies("a=hello%20world").a).toBe("hello world");
  });

  it("builds a Set-Cookie with the expected attributes", () => {
    const s = buildSetCookie(
      SESSION_COOKIE,
      "v",
      "HttpOnly; Secure; SameSite=Strict; Path=/",
      60,
    );
    expect(s).toContain("HttpOnly");
    expect(s).toContain("Secure");
    expect(s).toContain("SameSite=Strict");
    expect(s).toContain("Max-Age=60");
  });

  it("clears a cookie by expiring it with matching attributes", () => {
    const s = buildClearCookie(SESSION_COOKIE, true);
    expect(s).toContain("Max-Age=0");
    expect(s).toContain("HttpOnly");
    expect(s).toContain("SameSite=Strict");
  });

  it("generates distinct random tokens", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken()).toHaveLength(64);
  });

  it("compares tokens safely and rejects mismatches", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch(null, "abc")).toBe(false);
    expect(tokensMatch("abc", null)).toBe(false);
  });

  it("requires CSRF only for state-changing methods", () => {
    expect(csrfRequired("GET")).toBe(false);
    expect(csrfRequired("HEAD")).toBe(false);
    expect(csrfRequired("OPTIONS")).toBe(false);
    expect(csrfRequired("POST")).toBe(true);
    expect(csrfRequired("put")).toBe(true);
    expect(csrfRequired("DELETE")).toBe(true);
  });
});

describe("bearerToken (SEC-005)", () => {
  it("accepts a properly prefixed bearer token", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
  });

  it("rejects a bare token with no Bearer prefix", () => {
    // SEC-005: this used to authenticate. A bare token is not recognised as a
    // credential by most intermediaries, so it survives in proxy logs that
    // redact only Authorization.
    expect(bearerToken("abc123")).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("isAdmin", () => {
  const ctx = (headers: Record<string, string>) => ({
    req: { header: (n: string) => headers[n.toLowerCase()] },
  });

  it("fails closed when ADMIN_TOKEN is unset", () => {
    const e = { ADMIN_TOKEN: undefined } as never;
    expect(isAdmin(ctx({ cookie: "mpx_session=anything" }), e)).toBe(false);
  });

  it("accepts a valid session cookie", () => {
    expect(
      isAdmin(ctx({ cookie: `${SESSION_COOKIE}=${STRONG_TOKEN}` }), env()),
    ).toBe(true);
  });

  it("accepts a valid Bearer token (curl/CI path)", () => {
    expect(
      isAdmin(ctx({ authorization: `Bearer ${STRONG_TOKEN}` }), env()),
    ).toBe(true);
  });

  it("rejects a wrong token in either channel", () => {
    expect(isAdmin(ctx({ cookie: `${SESSION_COOKIE}=wrong` }), env())).toBe(
      false,
    );
    expect(
      isAdmin(ctx({ authorization: "Bearer wrong-but-long-enough-token" }), env()),
    ).toBe(false);
  });

  it("rejects the x-admin-token header entirely (SEC-005)", () => {
    expect(
      isAdmin(ctx({ "x-admin-token": STRONG_TOKEN }), env()),
    ).toBe(false);
  });
});

describe("csrfOk", () => {
  const ctx = (headers: Record<string, string>, method = "POST") => ({
    req: { header: (n: string) => headers[n.toLowerCase()] },
    method,
  });

  it("passes safe methods without a token", () => {
    expect(csrfOk(ctx({}, "GET"))).toBe(true);
  });

  it("rejects a state-changing request with no CSRF cookie", () => {
    expect(csrfOk(ctx({}, "POST"))).toBe(false);
  });

  it("rejects a mismatched CSRF token", () => {
    expect(
      csrfOk(ctx({ cookie: `${CSRF_COOKIE}=good`, "x-csrf-token": "bad" })),
    ).toBe(false);
  });

  it("accepts a matching double-submit token", () => {
    expect(
      csrfOk(ctx({ cookie: `${CSRF_COOKIE}=good`, "x-csrf-token": "good" })),
    ).toBe(true);
  });
});

describe("POST /api/admin/login", () => {
  it("sets HttpOnly session + CSRF cookies and never returns the token (SEC-001)", async () => {
    const app = createApi(env());
    const res = await app.fetch(
      jsonReq("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({
          id: "admin",
          password: "correct-horse-battery",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    expect(session).toBeDefined();
    // The core of SEC-001: HttpOnly means no script can read the token.
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Strict");
    expect(csrf).toBeDefined();
    // CSRF cookie must be readable by our own client, so no HttpOnly on it.
    expect(csrf).not.toContain("HttpOnly");

    // The token must not be echoed in the body.
    const body = await res.text();
    expect(body).not.toContain(STRONG_TOKEN);
    const j = JSON.parse(body) as { ok: boolean; csrf_token: string };
    expect(j.ok).toBe(true);
    expect(j.csrf_token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 401 on wrong credentials and does not set cookies", async () => {
    const app = createApi(env());
    const res = await app.fetch(
      jsonReq("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ id: "admin", password: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("refuses to issue a weak ADMIN_TOKEN (SEC-006, fail closed)", async () => {
    const app = createApi(
      env({ ADMIN_TOKEN: "short-token" }), // < 32 chars
    );
    const res = await app.fetch(
      jsonReq("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({
          id: "admin",
          password: "correct-horse-battery",
        }),
      }),
    );
    expect(res.status).toBe(500);
    // Previously this logged a warning and handed the weak token out anyway.
    expect(await res.text()).toContain("strength policy");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

describe("admin route auth + CSRF (integration)", () => {
  it("refuses a session-cookie POST with no CSRF header", async () => {
    const app = createApi(env());
    const res = await app.fetch(
      jsonReq("/api/admin/models/1/toggle", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${STRONG_TOKEN}` },
        body: JSON.stringify({ enabled: 1 }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("csrf");
  });

  it("accepts a session-cookie POST with a matching CSRF header", async () => {
    const app = createApi(env());
    const csrf = randomToken();
    const res = await app.fetch(
      jsonReq("/api/admin/models/1/toggle", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${STRONG_TOKEN}; ${CSRF_COOKIE}=${csrf}`,
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ enabled: 1 }),
      }),
    );
    // Not 403 — the CSRF barrier passed. The DB stub yields no model row, so
    // the route itself 404s, which still proves auth+CSRF were accepted.
    expect(res.status).not.toBe(403);
  });

  it("rejects an unauthenticated admin call with no cookie or token", async () => {
    const app = createApi(env());
    const res = await app.fetch(
      jsonReq("/api/admin/discover", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("no longer authenticates via x-admin-token", async () => {
    const app = createApi(env());
    const res = await app.fetch(
      jsonReq("/api/admin/discover", {
        method: "POST",
        headers: { "x-admin-token": STRONG_TOKEN },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("SEC-003: unauthenticated audit write amplification", () => {
  it("does not write an audit row for a bare unauthenticated probe", async () => {
    const db = fakeDb();
    const app = createApi(env({ DB: db }));
    await app.fetch(jsonReq("/api/admin/discover", { method: "POST" }));
    expect(db.auditInserts).toBe(0);
  });

  it("does not write an audit row for a 404 on a non-existent admin path", async () => {
    const db = fakeDb();
    const app = createApi(env({ DB: db }));
    await app.fetch(jsonReq("/api/admin/does-not-exist", { method: "GET" }));
    expect(db.auditInserts).toBe(0);
  });

  it("still audits a presented credential that failed (brute-force signal)", async () => {
    const db = fakeDb();
    const app = createApi(env({ DB: db }));
    await app.fetch(
      jsonReq("/api/admin/discover", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-value-here" },
      }),
    );
    expect(db.auditInserts).toBe(1);
  });

  it("still audits a login attempt", async () => {
    const db = fakeDb();
    const app = createApi(env({ DB: db }));
    await app.fetch(
      jsonReq("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ id: "admin", password: "wrong" }),
      }),
    );
    expect(db.auditInserts).toBe(1);
  });
});
