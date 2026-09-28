import { Hono } from "hono";
import type { BenchmarkType, Env } from "../../types";
import { runDiscovery } from "../../benchmark/scheduler";
import { isAdmin } from "../shared";
import { isStrongToken, timingSafeEqual } from "../../utils/security";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_ATTRS,
  SESSION_MAX_AGE_S,
  CSRF_COOKIE_ATTRS,
  buildClearCookie,
  buildSetCookie,
  randomToken,
} from "../../utils/admin-session";
import { getClientIp } from "../../utils/rate-limit";
import {
  clearLoginAttempts,
  decideThrottle,
  readLoginAttempt as readThrottle,
  recordLoginAttempt,
} from "../../db/login-throttle";

export function adminRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  // ——— Admin login + model toggle (per-model benchmark_enabled) ———
  // Login verifies ADMIN_ID / ADMIN_PASSWORD (secrets) and returns the bearer token that isAdmin checks.
  // Keeps ALL discovered models stored; disabled ones simply skip scheduler queue until admin re-enables.
  r.post("/admin/login", async (c) => {
    // SEC-004: cross-isolate throttle. Checked BEFORE any credential work, so
    // a blocked IP never reaches the password comparison at all. The
    // per-isolate in-memory slider in routes.ts remains the cheap first line;
    // this is the shared bucket that survives isolate rotation and spans PoPs.
    const ip = getClientIp(c.req.raw);
    // `readLoginAttempt` returns null when the table is missing (pre-migration)
    // or D1 is unreachable. Both mean "no cross-isolate record" — the
    // in-memory slider in routes.ts still applies, so this must fail open to
    // that, never to "unlimited" and never to blocking all logins.
    const prior = await readThrottle(env.DB, ip);
    const decision = prior
      ? decideThrottle(
          prior.attempts,
          prior.firstAt,
          prior.blockedUntil,
          Date.now(),
        )
      : { blocked: false, attempts: 0, retryAfter: 0 };
    if (decision.blocked) {
      c.header("retry-after", String(decision.retryAfter));
      return c.json(
        { error: "too many login attempts", retry_after: decision.retryAfter },
        429,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      username?: string;
      password?: string;
      pass?: string;
    };
    const id = (body.id ?? body.username ?? "").trim();
    const pass = (body.password ?? body.pass ?? "").trim();
    const expectedId = String(
      env.ADMIN_ID ??
        (env as Record<string, unknown>)["ADMIN_USERNAME"] ??
        "admin",
    ).trim();
    const expectedPass = String(env.ADMIN_PASSWORD ?? "").trim();
    const token = String(env.ADMIN_TOKEN ?? "");
    // Constant-time checks + no token-as-password fallback; ADMIN_PASSWORD must be configured
    const idOk = timingSafeEqual(id, expectedId);
    const passOk = expectedPass ? timingSafeEqual(pass, expectedPass) : false;
    // Symmetric jitter 80-150ms on both success and failure paths to avoid timing oracle (P1)
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 70));
    if (!idOk || !passOk) {
      // Count the attempt in the shared bucket so the limit holds across
      // isolates. A correct guess is indistinguishable from a wrong one here,
      // which is the point: the counter must not leak whether the id or the
      // password was the part that was right.
      await recordLoginAttempt(env.DB, ip);
      return c.json({ error: "invalid credentials" }, 401);
    }
    // Success resets the shared bucket — otherwise a legitimate user who
    // fat-fingered a few times stays throttled for the rest of the window.
    await clearLoginAttempts(env.DB, ip);
    if (!token)
      return c.json({ error: "ADMIN_TOKEN not configured" }, 500);
    // SEC-006: fail closed on a weak token. This used to log a warning and hand
    // the weak value out anyway, which made the strength policy advisory rather
    // than a control. An operator who has not rotated gets a clear 500 telling
    // them exactly what to do — which is strictly better than silently issuing a
    // guessable admin token. Checked before the old `length < 16` gate so a
    // short token gets the actionable strength message rather than the vague
    // "not configured" one.
    if (!isStrongToken(token)) {
      console.error(
        "ADMIN_TOKEN rejected: fails strength policy (>=32 chars, not a placeholder). Run: wrangler secret put ADMIN_TOKEN",
      );
      return c.json(
        {
          error:
            "ADMIN_TOKEN fails the strength policy and was not issued. Set it to >=32 random characters: wrangler secret put ADMIN_TOKEN",
        },
        500,
      );
    }
    // SEC-001: the token goes into an HttpOnly cookie, never into the response
    // body. A JSON body carrying the token is readable by any script on the
    // page and lands in devtools/proxy logs; HttpOnly makes it unreachable
    // from JavaScript for the life of the session.
    const csrf = randomToken(32);
    // Two separate Set-Cookie headers. Combined into one comma-joined value
    // they would be parsed as a single cookie by strict clients, and cookie
    // values may legitimately contain commas.
    c.header(
      "set-cookie",
      buildSetCookie(SESSION_COOKIE, token, SESSION_COOKIE_ATTRS, SESSION_MAX_AGE_S),
      { append: true },
    );
    c.header(
      "set-cookie",
      buildSetCookie(CSRF_COOKIE, csrf, CSRF_COOKIE_ATTRS, SESSION_MAX_AGE_S),
      { append: true },
    );
    // No token in the body. Clients that need a value for scripting can log in
    // and use the cookie; the CSRF token is returned here because it is
    // deliberately JS-readable and is not a secret on its own (it is useless
    // without the HttpOnly session cookie).
    return c.json({ ok: true, csrf_token: csrf });
  });

  // Explicit logout — clears both auth cookies with matching attributes.
  r.post("/admin/logout", (c) => {
    c.header("set-cookie", buildClearCookie(SESSION_COOKIE, true), {
      append: true,
    });
    c.header("set-cookie", buildClearCookie(CSRF_COOKIE, false), {
      append: true,
    });
    return c.json({ ok: true });
  });

  // admin

  r.post("/admin/discover", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const r = await runDiscovery(env);
    return c.json(r);
  });
  r.post("/admin/benchmark", async (c) => {
    if (!isAdmin(c, env)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      model_id?: number;
      benchmark_type?: BenchmarkType;
    };
    if (!body.model_id) return c.json({ error: "model_id required" }, 400);
    const bt = (body.benchmark_type ?? "coding") as BenchmarkType;
    const job = await env.DB.prepare(
      "SELECT m.provider_model_id, p.name as provider, m.display_name FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?",
    )
      .bind(body.model_id)
      .first<{
        provider_model_id: string;
        provider: string;
        display_name: string;
      }>();
    if (!job) return c.json({ error: "model not found" }, 404);
    await env.BENCH_QUEUE.send({
      model_id: body.model_id,
      provider: job.provider,
      provider_model_id: job.provider_model_id,
      benchmark_type: bt,
      display_name: job.display_name,
    });
    return c.json({ queued: true });
  });
  return r;
}
