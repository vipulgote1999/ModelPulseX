import { Hono } from "hono";

/** Hand-written OpenAPI 3.1 document — no codegen dependency.
 *  Covers the public read-only surface in full. Admin paths are documented as
 *  bearerAuth secured but without internal parameter enumeration. Never serializes env.
 */
export function buildOpenApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "ModelPulseX API",
      version: "0.1.0",
      description:
        "Live streaming throughput, latency and reliability benchmarks for free LLM models. All benchmark state lives in D1; public read-only endpoints are unauthenticated.",
    },
    servers: [
      {
        url: "https://modelpulsex.vipulgote5.workers.dev",
        description: "Production",
      },
    ],
    paths: {
      "/api/health": {
        get: {
          summary: "Health + freshness probe",
          parameters: [
            {
              name: "freshness",
              in: "query",
              required: false,
              schema: { type: "integer", default: 15 },
              description: "Minutes threshold; returns 503 if stale",
            },
          ],
          responses: {
            "200": { description: "Healthy" },
            "503": { description: "Stale" },
          },
        },
      },
      "/api/providers": {
        get: {
          summary: "List providers with endpoints + free-tier limits + usage",
          responses: { "200": { description: "Providers + registry" } },
        },
      },
      "/api/models": {
        get: {
          summary: "List models (free + previously free)",
          parameters: [
            {
              name: "provider",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "includeInactive",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["1"] },
            },
          ],
          responses: { "200": { description: "Models" } },
        },
      },
      "/api/models/{id}": {
        get: {
          summary: "Get model by id",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": { description: "Model" },
            "404": { description: "Not found" },
          },
        },
      },
      "/api/models/{id}/history": {
        get: {
          summary: "Hourly / 10m history for one model",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
            {
              name: "range",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["1h", "24h", "3d", "7d"],
                default: "7d",
              },
            },
            {
              name: "benchmark",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["all", "coding"],
                default: "all",
              },
            },
            {
              name: "granularity",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["hourly", "10m"],
                default: "hourly",
              },
            },
          ],
          responses: { "200": { description: "History points" } },
        },
      },
      "/api/models/{id}/incidents": {
        get: {
          summary: "Incidents for one model",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: { "200": { description: "Incidents + uptime" } },
        },
      },
      "/api/leaderboard": {
        get: {
          summary: "Leaderboard with medians + gating + sparkline",
          description:
            "status is null on overlay miss (no latest-run measurement); null-status rows are unranked (rank null) with overall_score null. meta.alert_channel is log-only until ALERT_WEBHOOK_URL is set. Throughput: tps_* is Decode TPS (excludes TTFT); e2e_tps_* is End-to-end TPS (includes TTFT) and is the only throughput metric used for ranking. median_chunks_7d < 8 means block delivery.",
          parameters: [
            {
              name: "range",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["1h", "24h", "3d", "7d"],
                default: "7d",
              },
            },
            {
              name: "provider",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "benchmark",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["all", "coding"],
                default: "all",
              },
            },
            {
              name: "sort",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["overall", "tps", "ttft", "uptime"],
                default: "overall",
              },
            },
            {
              name: "profile",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["balanced", "fastest", "latency", "reliable", "coding"],
                default: "balanced",
              },
            },
          ],
          responses: { "200": { description: "Leaderboard" } },
        },
      },
      "/api/history": {
        get: {
          summary: "Batch history for charts (single request for N models)",
          description:
            "median_tps is Decode TPS (excludes TTFT); median_e2e_tps is the additive End-to-end TPS (includes TTFT). Both are medians of the requested window/granularity.",
          parameters: [
            {
              name: "ids",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Comma-separated model ids, max 12",
            },
            {
              name: "range",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["1h", "24h", "3d", "7d"],
                default: "7d",
              },
            },
            {
              name: "benchmark",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["all", "coding"],
                default: "all",
              },
            },
            {
              name: "granularity",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["hourly", "10m"] },
            },
          ],
          responses: {
            "200": { description: "History map" },
            "400": { description: "Missing ids" },
          },
        },
      },
      "/api/compare": {
        get: {
          summary: "Compare models side-by-side",
          description:
            "Snapshot medians carrying both Decode TPS (excludes TTFT) and End-to-end TPS (includes TTFT). recommended_provider is chosen on e2e_tps_7d; median_chunks_7d < 8 means block delivery.",
          parameters: [
            {
              name: "model",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "models",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Comparison" },
            "404": { description: "No models matched" },
          },
        },
      },
      "/api/cooldowns": {
        get: {
          summary: "Active cooldowns (provider + model)",
          responses: { "200": { description: "Cooldowns" } },
        },
      },
      "/api/timeouts": {
        get: {
          summary:
            "Refusal history by day/provider/status + per-provider limits",
          parameters: [
            {
              name: "range",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["1h", "24h", "3d", "7d"],
                default: "7d",
              },
            },
          ],
          responses: {
            "200": { description: "Timeout history" },
            "400": { description: "Invalid range" },
          },
        },
      },
      "/api/live": {
        get: {
          summary: "SSE live stream via Durable Object",
          responses: { "200": { description: "Event stream" } },
        },
      },
      "/api/openapi.json": {
        get: {
          summary: "This OpenAPI document",
          responses: { "200": { description: "OpenAPI JSON" } },
        },
      },
      "/api/og.png": {
        get: {
          summary: "OG share card PNG (1200x630)",
          responses: {
            "200": { description: "PNG image", content: { "image/png": {} } },
          },
        },
      },
      "/api/admin/login": {
        post: {
          summary: "Admin login",
          // No `security` here: this is the credential-exchange endpoint and is
          // unauthenticated by definition. It sets the session via an HttpOnly
          // cookie, so the token is never returned in the response body.
          // NOTE: must not name env vars — test/openapi.test.ts asserts the
          // published spec contains no secret NAMES (an attacker's map of what
          // to go hunting for). Describe the mechanism, not the variable.
          description:
            "Exchanges the admin id + password for an HttpOnly session cookie " +
            "(mpx_session) plus a JS-readable CSRF token (mpx_csrf) that must be " +
            "echoed in the X-CSRF-Token header on state-changing admin requests. " +
            "The session token is never included in the response body.",
          responses: {
            "200": { description: "Session cookie set; csrf_token returned" },
            "401": { description: "Invalid credentials" },
            "429": { description: "Too many attempts (5 per 15 min per IP)" },
            // Must not name the env var — see the note above.
            "500": {
              description:
                "Server session secret unset or below the length policy; not issued",
            },
          },
        },
      },
      "/api/admin/logout": {
        post: {
          summary: "Admin logout",
          description: "Clears the mpx_session and mpx_csrf cookies.",
          responses: { "200": { description: "Cookies cleared" } },
        },
      },
      "/api/admin/models": {
        get: {
          summary: "Admin list models",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Models" } },
        },
      },
      "/api/admin/models/{id}/toggle": {
        post: {
          summary: "Toggle model benchmark",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: { "200": { description: "Updated" } },
        },
      },
      "/api/admin/models/bulk": {
        post: {
          summary: "Bulk model update",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Updated" } },
        },
      },
      "/api/admin/discover": {
        post: {
          summary: "Trigger discovery",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/benchmark": {
        post: {
          summary: "Trigger benchmark",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/playground/test": {
        post: {
          summary: "Ephemeral provider test (no D1 writes)",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/reaggregate": {
        post: {
          summary: "Re-aggregate hourly stats",
          description:
            "Accepts { hour?: ISO string, refresh_snapshot?: boolean }. Defaults to the current UTC hour and rejects hours older than 30 days or in the future.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    hour: { type: "string", format: "date-time" },
                    refresh_snapshot: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/backfill-e2e": {
        post: {
          summary: "Backfill end-to-end TPS from JS timestamps",
          description:
            "Recomputes e2e_tps for NULL rows in the last 1–7 days (default 7) using the whole request window. Decode tps is never modified.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    days: { type: "integer", minimum: 1, maximum: 7 },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/cleanup": {
        post: {
          summary: "Cleanup retention",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/cooldown/reset": {
        post: {
          summary: "Reset cooldowns",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/migrate": {
        post: {
          summary: "Run migrations",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Result" } },
        },
      },
      "/api/admin/fix-tps": {
        post: {
          summary: "Fix TPS calculations",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Result" } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  } as const;
}

export function openApiRoutes() {
  const r = new Hono();
  r.get("/openapi.json", (c) => c.json(buildOpenApiSpec()));
  return r;
}
