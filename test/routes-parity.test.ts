import { describe, it, expect } from "vitest";
import { createApi } from "../src/api/routes";

const EXPECTED = [
  "GET /api/health",
  "GET /api/providers",
  "GET /api/models",
  "GET /api/leaderboard",
  "GET /api/history",
  "GET /api/models/:id",
  "GET /api/models/:id/history",
  "GET /api/models/:id/incidents",
  "GET /api/compare",
  "GET /api/cooldowns",
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
    const actual = (app as unknown as { routes: Array<{ path: string; method: string }> })
      .routes.filter((r) => r.method === "GET" || r.method === "POST")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(actual).toEqual([...EXPECTED].sort());
  });
});
