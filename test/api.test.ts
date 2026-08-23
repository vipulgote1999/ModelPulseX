import { describe, it, expect } from "vitest";

// small integration sanity: ensure D1 schema strings contain required tables and indexes
// @ts-ignore node types missing in workers context
import { readFileSync } from "node:fs";

describe("api/contracts — D1 schema", () => {
  it("migrations contain all required tables", () => {
    const sql = readFileSync("migrations/0001_initial.sql", "utf8");
    for (const t of ["providers", "models", "benchmark_runs", "hourly_model_stats", "availability_incidents", "benchmark_config"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
    expect(sql.toLowerCase()).toContain("never store response bodies");
  });
  it("indexes created", () => {
    const sql = readFileSync("migrations/0002_indexes.sql", "utf8");
    expect(sql).toContain("idx_models_active_free");
    expect(sql).toContain("idx_benchmark_runs_model_time");
  });
  it("leaderboard query does not scan raw per request — uses hourly stats", async () => {
    const routes = readFileSync("src/api/routes.ts", "utf8");
    expect(routes).toContain("hourly_model_stats");
    expect(routes).toContain("parseRange");
    expect(routes).toContain("is_stale");
  });
});
