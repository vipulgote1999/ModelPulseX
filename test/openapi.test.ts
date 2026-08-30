import { describe, it, expect } from "vitest";
import { buildOpenApiSpec } from "../src/api/openapi";

describe("openapi spec", () => {
  it("lists every public GET route", () => {
    const spec = buildOpenApiSpec() as unknown as { paths: Record<string, Record<string, unknown>> };
    const publicGets = [
      "/api/health",
      "/api/providers",
      "/api/models",
      "/api/models/{id}",
      "/api/models/{id}/history",
      "/api/models/{id}/incidents",
      "/api/leaderboard",
      "/api/history",
      "/api/compare",
      "/api/cooldowns",
      "/api/live",
      "/api/openapi.json",
      "/api/og.png",
    ];
    for (const p of publicGets) {
      expect(spec.paths[p], `missing ${p}`).toBeDefined();
      expect(spec.paths[p]!["get"]).toBeDefined();
    }
  });

  it("declares bearerAuth security for admin paths", () => {
    const spec = buildOpenApiSpec() as unknown as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    const adminPaths = Object.keys(spec.paths).filter((p) => p.startsWith("/api/admin"));
    expect(adminPaths.length).toBeGreaterThan(0);
    for (const p of adminPaths) {
      const methods = spec.paths[p]!;
      for (const m of Object.values(methods)) {
        expect((m as { security?: unknown[] }).security, `missing security for ${p}`).toBeDefined();
      }
    }
  });

  it("does not leak env var names or key material", () => {
    const spec = buildOpenApiSpec();
    const json = JSON.stringify(spec);
    // Should not contain common secret env names
    for (const secret of ["OPENCODE_API_KEY", "OPENROUTER_API_KEY", "ADMIN_TOKEN", "GROQ_API_KEY"]) {
      expect(json).not.toContain(secret);
    }
    // No serialization of env object keys
    expect(json).not.toContain("CORS_ORIGIN");
  });
});
