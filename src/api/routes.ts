import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { healthRoutes } from "./health";
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

  // Origin allowlist (comma-separated env override) instead of "*": the dashboard is
  // same-origin so it needs no CORS at all, and a public read-only API must never send
  // Access-Control-Allow-Origin:* alongside credential-bearing admin endpoints.
  const allowedOrigins = (
    env.CORS_ORIGIN ?? "https://modelpulsex.vipulgote5.workers.dev"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: allowedOrigins,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.route("/api", healthRoutes(env));
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

  return app;
}
