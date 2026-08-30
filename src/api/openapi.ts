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
      description: "Live streaming throughput, latency and reliability benchmarks for free LLM models. All benchmark state lives in D1; public read-only endpoints are unauthenticated.",
    },
    servers: [{ url: "https://modelpulsex.vipulgote5.workers.dev", description: "Production" }],
    paths: {
      "/api/health": {
        get: {
          summary: "Health + freshness probe",
          parameters: [
            { name: "freshness", in: "query", required: false, schema: { type: "integer", default: 15 }, description: "Minutes threshold; returns 503 if stale" },
          ],
          responses: { "200": { description: "Healthy" }, "503": { description: "Stale" } },
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
            { name: "provider", in: "query", required: false, schema: { type: "string" } },
            { name: "includeInactive", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
          ],
          responses: { "200": { description: "Models" } },
        },
      },
      "/api/models/{id}": {
        get: {
          summary: "Get model by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Model" }, "404": { description: "Not found" } },
        },
      },
      "/api/models/{id}/history": {
        get: {
          summary: "Hourly / 10m history for one model",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "range", in: "query", required: false, schema: { type: "string", enum: ["1h", "24h", "3d", "7d"], default: "7d" } },
            { name: "benchmark", in: "query", required: false, schema: { type: "string", enum: ["all", "short", "medium", "coding"], default: "all" } },
            { name: "granularity", in: "query", required: false, schema: { type: "string", enum: ["hourly", "10m"], default: "hourly" } },
          ],
          responses: { "200": { description: "History points" } },
        },
      },
      "/api/models/{id}/incidents": {
        get: {
          summary: "Incidents for one model",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Incidents + uptime" } },
        },
      },
      "/api/leaderboard": {
        get: {
          summary: "Leaderboard with medians + gating + sparkline",
          parameters: [
            { name: "range", in: "query", required: false, schema: { type: "string", enum: ["1h", "24h", "3d", "7d"], default: "7d" } },
            { name: "provider", in: "query", required: false, schema: { type: "string" } },
            { name: "benchmark", in: "query", required: false, schema: { type: "string", enum: ["all", "short", "medium", "coding"], default: "all" } },
            { name: "sort", in: "query", required: false, schema: { type: "string", enum: ["overall", "tps", "ttft", "uptime"], default: "overall" } },
            { name: "profile", in: "query", required: false, schema: { type: "string", enum: ["balanced", "fastest", "latency", "reliable", "coding"], default: "balanced" } },
          ],
          responses: { "200": { description: "Leaderboard" } },
        },
      },
      "/api/history": {
        get: {
          summary: "Batch history for charts (single request for N models)",
          parameters: [
            { name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated model ids, max 12" },
            { name: "range", in: "query", required: false, schema: { type: "string", enum: ["1h", "24h", "3d", "7d"], default: "7d" } },
            { name: "benchmark", in: "query", required: false, schema: { type: "string", enum: ["all", "short", "medium", "coding"], default: "all" } },
            { name: "granularity", in: "query", required: false, schema: { type: "string", enum: ["hourly", "10m"] } },
          ],
          responses: { "200": { description: "History map" }, "400": { description: "Missing ids" } },
        },
      },
      "/api/compare": {
        get: {
          summary: "Compare models side-by-side",
          parameters: [
            { name: "model", in: "query", required: false, schema: { type: "string" } },
            { name: "models", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Comparison" }, "404": { description: "No models matched" } },
        },
      },
      "/api/cooldowns": {
        get: {
          summary: "Active cooldowns (provider + model)",
          responses: { "200": { description: "Cooldowns" } },
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
          responses: { "200": { description: "PNG image", content: { "image/png": {} } } },
        },
      },
      "/api/admin/login": {
        post: {
          summary: "Admin login",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Token" }, "401": { description: "Unauthorized" } },
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
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
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
      "/api/admin/reaggregate": {
        post: {
          summary: "Re-aggregate hourly stats",
          security: [{ bearerAuth: [] }],
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
