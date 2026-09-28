import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../types";
import { validateCorsConfig, sanitizeErrorMessage } from "../utils/security";
import { checkRateLimit, getClientIp, rateKey } from "../utils/rate-limit";
import { healthRoutes } from "./health";
import { openApiRoutes } from "./openapi";
import { ogRoutes } from "./og";
import { providersRoutes } from "./providers";
import { modelsRoutes } from "./models";
import { leaderboardRoutes } from "./leaderboard";
import { historyRoutes } from "./history";
import { compareRoutes } from "./compare";
import { cooldownsRoutes } from "./cooldowns";
import { timeoutsRoutes } from "./timeouts";
import { liveRoutes } from "./live";
import { adminRoutes } from "./admin";
import { recordAudit } from "../db/audit";
import { isAdmin, bearerToken, sessionCookie, csrfOk } from "./shared";
import { adminModelsRoutes } from "./admin/models";
import { adminMaintenanceRoutes } from "./admin/maintenance";
import { playgroundRoutes } from "./admin/playground";

export function createApi(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Strict CORS allowlist validation — reject wildcard and log misconfig (security hardening from stash)
  const corsCheck = validateCorsConfig(env.CORS_ORIGIN);
  if (!corsCheck.valid)
    console.error("CORS misconfig:", corsCheck.reason, corsCheck.origins);
  const allowedOrigins = corsCheck.origins.length
    ? corsCheck.origins
    : (env.CORS_ORIGIN ?? "https://modelpulsex.vipulgote5.workers.dev")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (!corsCheck.valid && allowedOrigins.length === 0) {
    // fallback to default if validation yielded empty
    allowedOrigins.push("https://modelpulsex.vipulgote5.workers.dev");
  }
  app.use(
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.text("payload too large", 413),
    }),
  );
  // Global rate limit: 120 req / min per IP for public API, 30 for admin, 5/15m for login (best-effort in-memory)
  app.use("/api/*", async (c, next) => {
    const ip = getClientIp(c.req.raw);
    let path: string;
    try {
      path = new URL(c.req.url).pathname;
    } catch {
      path = "";
    }
    const scope = path.startsWith("/api/admin/login")
      ? "login"
      : path.startsWith("/api/admin/")
        ? "admin"
        : "api";
    const limits: Record<string, { windowMs: number; max: number }> = {
      login: { windowMs: 15 * 60_000, max: 5 },
      admin: { windowMs: 60_000, max: 30 },
      api: { windowMs: 60_000, max: 120 },
    };
    const lim = limits[scope] ?? limits.api;
    const r = checkRateLimit(rateKey(ip, scope), lim);
    c.header("x-ratelimit-limit", String(lim.max));
    c.header("x-ratelimit-remaining", String(r.remaining));
    c.header("x-ratelimit-reset", String(Math.ceil(r.resetMs / 1000)));
    if (!r.allowed) {
      c.header("retry-after", String(Math.ceil(r.resetMs / 1000)));
      return c.json(
        { error: "rate limited", retry_after: Math.ceil(r.resetMs / 1000) },
        429,
      );
    }
    await next();
  });
  app.use(
    cors({
      origin: (origin, _c) => {
        if (!origin) return null;
        if (allowedOrigins.includes(origin)) return origin;
        console.warn(
          "CORS blocked origin",
          origin,
          "allowed",
          allowedOrigins.length,
        );
        return null;
      },
      // `x-admin-token` removed (SEC-005): a custom auth header is routinely
      // logged verbatim by proxies and log shippers, which normally redact
      // Authorization. `x-csrf-token` is added for the double-submit check and
      // is not a credential on its own.
      allowHeaders: [
        "content-type",
        "authorization",
        "x-csrf-token",
        "x-request-id",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
      credentials: true,
      maxAge: 600,
    }),
  );

  // Admin audit trail. Registered AFTER the rate limiter on purpose: a request
  // refused with 429 never reaches this middleware, so hammering cannot turn a
  // capped login attempt into one D1 write per request. 429s are not audited —
  // the limiter is the record there.
  //
  // SEC-003: this previously wrote a row for EVERY /api/admin/* request,
  // including requests with no credential that got a 401, and including 404s
  // for paths that do not exist. The only bound was the per-isolate in-memory
  // limiter (30/min), so a client spreading across source IPs could drive
  // unbounded writes against the D1 write quota. The forensic signal is
  // preserved and the amplification is dropped: a row is written when the
  // request was authenticated, when it presented a credential that failed
  // (that is the brute-force signal), or on any /api/admin/login attempt.
  // A bare unauthenticated probe with no credential carries no signal a real
  // attempt would lack, so it is not written.
  app.use("/api/admin/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next(); // CORS preflight is not an action
    // SEC-001 CSRF gate. Placed before the route handler so a state-changing
    // request is rejected without running any handler logic or D1 work.
    // Only enforced once a session cookie is actually present: a Bearer-authed
    // curl/CI call has no cookie to double-submit against, and SameSite=Strict
    // already means the browser will not attach the session cookie to a
    // cross-site request in the first place.
    if (sessionCookie(c.req) && !csrfOk({ req: c.req, method: c.req.method }))
      return c.json({ error: "csrf token missing or invalid" }, 403);
    const isLogin = c.req.path === "/api/admin/login";
    const presented =
      bearerToken(c.req.header("authorization")) ??
      sessionCookie(c.req) ??
      "";
    await next();
    const authed = c.res.status < 400 && isAdmin(c, env);
    // Write on: success, an explicit login attempt, or a presented credential
    // that did not work. Skip: unauthenticated no-credential probes.
    if (!authed && !presented && !isLogin) return;
    await recordAudit(env.DB, {
      action: `${c.req.method.toLowerCase()} ${c.req.path}`,
      actor: presented,
      ip: c.req.header("cf-connecting-ip") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      details: { status: c.res.status },
    });
  });

  app.route("/api", healthRoutes(env));
  app.route("/api", openApiRoutes());
  app.route("/api", ogRoutes(env));
  app.route("/api", providersRoutes(env));
  app.route("/api", modelsRoutes(env));
  app.route("/api", leaderboardRoutes(env));
  app.route("/api", historyRoutes(env));
  app.route("/api", compareRoutes(env));
  app.route("/api", cooldownsRoutes(env));
  app.route("/api", timeoutsRoutes(env));
  app.route("/api", liveRoutes(env));
  app.route("/api", adminRoutes(env));
  app.route("/api", adminModelsRoutes(env));
  app.route("/api", adminMaintenanceRoutes(env));
  app.route("/api", playgroundRoutes(env));

  // Global error handler — never leak internals (security hardening).
  // D1 quota breach gets a distinct 503 so clients (and the dashboard) can
  // show "back at midnight UTC" instead of a generic 500: the message match
  // needs no D1 access, which is exactly what's down in that situation.
  app.onError((err, c) => {
    console.error("unhandled api error", err);
    const msg = String((err as Error)?.message ?? err ?? "");
    if (/row read limit|exceeded.*free tier/i.test(msg)) {
      return c.json(
        {
          error: "d1_quota_exceeded",
          message:
            "Database daily read quota reached — public data resumes after midnight UTC.",
        },
        503,
      );
    }
    return c.json({ error: sanitizeErrorMessage(err) }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
