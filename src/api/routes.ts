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
import { liveRoutes } from "./live";
import { adminRoutes } from "./admin";
import { adminModelsRoutes } from "./admin/models";
import { adminMaintenanceRoutes } from "./admin/maintenance";

export function createApi(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Strict CORS allowlist validation — reject wildcard and log misconfig (security hardening from stash)
  const corsCheck = validateCorsConfig(env.CORS_ORIGIN);
  if (!corsCheck.valid) console.error("CORS misconfig:", corsCheck.reason, corsCheck.origins);
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
  app.use(bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.text("payload too large", 413) }));
  // Global rate limit: 120 req / min per IP for public API, 30 for admin, 5/15m for login (best-effort in-memory)
  app.use("/api/*", async (c, next) => {
    const ip = getClientIp(c.req.raw);
    let path: string;
    try {
      path = new URL(c.req.url).pathname;
    } catch {
      path = "";
    }
    const scope = path.startsWith("/api/admin/login") ? "login" : path.startsWith("/api/admin/") ? "admin" : "api";
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
      return c.json({ error: "rate limited", retry_after: Math.ceil(r.resetMs / 1000) }, 429);
    }
    await next();
  });
  app.use(
    cors({
      origin: (origin, _c) => {
        if (!origin) return null;
        if (allowedOrigins.includes(origin)) return origin;
        console.warn("CORS blocked origin", origin, "allowed", allowedOrigins.length);
        return null;
      },
      allowHeaders: ["content-type", "authorization", "x-admin-token", "x-request-id"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      credentials: true,
      maxAge: 600,
    }),
  );

  app.route("/api", healthRoutes(env));
  app.route("/api", openApiRoutes());
  app.route("/api", ogRoutes(env));
  app.route("/api", providersRoutes(env));
  app.route("/api", modelsRoutes(env));
  app.route("/api", leaderboardRoutes(env));
  app.route("/api", historyRoutes(env));
  app.route("/api", compareRoutes(env));
  app.route("/api", cooldownsRoutes(env));
  app.route("/api", liveRoutes(env));
  app.route("/api", adminRoutes(env));
  app.route("/api", adminModelsRoutes(env));
  app.route("/api", adminMaintenanceRoutes(env));

  // Global error handler — never leak internals (security hardening)
  app.onError((err, c) => {
    console.error("unhandled api error", err);
    return c.json({ error: sanitizeErrorMessage(err) }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
