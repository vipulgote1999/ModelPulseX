import { describe, it, expect } from "vitest";
import { createApi } from "../src/api/routes";
import { buildOpenApiSpec } from "../src/api/openapi";

const EXPECTED = [
  "GET /api/health",
  "GET /api/openapi.json",
  "GET /api/og.png",
  "GET /api/providers",
  "GET /api/models",
  "GET /api/leaderboard",
  "GET /api/history",
  "GET /api/models/:id",
  "GET /api/models/:id/history",
  "GET /api/models/:id/incidents",
  "GET /api/compare",
  "GET /api/cooldowns",
  "GET /api/timeouts",
  "POST /api/admin/login",
  "GET /api/admin/models",
  "POST /api/admin/models/:id/toggle",
  "POST /api/admin/models/bulk",
  "POST /api/admin/discover",
  "POST /api/admin/benchmark",
  "POST /api/admin/reaggregate",
  "POST /api/admin/cleanup",
  "POST /api/admin/cooldown/reset",
  "POST /api/admin/migrate",
  "POST /api/admin/fix-tps",
  "GET /api/live",
];

describe("api route parity", () => {
  it("mounts exactly the expected public surface", () => {
    // Env is only read lazily inside handlers; a stub is enough to build the app.
    const app = createApi({ CORS_ORIGIN: "https://example.test" } as never);
    const actual = (
      app as unknown as { routes: Array<{ path: string; method: string }> }
    ).routes
      .filter((r) => r.method === "GET" || r.method === "POST")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(actual).toEqual([...EXPECTED].sort());
  });

  it("OpenAPI documents exactly the mounted surface (issue #15: no silent drift)", () => {
    // The published contract is what integrators code against, so a route that
    // exists without docs — or docs for a route that does not exist — is a defect
    // in both directions. `{id}` in the spec == `:id` in the mounted path.
    const spec = buildOpenApiSpec() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const METHODS = new Set([
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
    ]);
    const documented = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths))
      for (const key of Object.keys(item))
        if (METHODS.has(key))
          documented.add(
            `${key.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`,
          );
    const mounted = new Set(EXPECTED);
    expect(
      [...mounted].filter((r) => !documented.has(r)),
      "mounted but undocumented",
    ).toEqual([]);
    expect(
      [...documented].filter((r) => !mounted.has(r)),
      "documented but not mounted",
    ).toEqual([]);
  });
});
