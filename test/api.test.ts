import { describe, it, expect } from "vitest";

// small integration sanity: ensure D1 schema strings contain required tables and indexes
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
  it("leaderboard derives TPS labels + ranks instead of hardcoding them (#11)", () => {
    const lb = readFileSync("src/api/leaderboard.ts", "utf8");
    expect(lb).toContain("measuredTpsLabel(");
    expect(lb).toContain("assignRanks(");
    // a constant label would silently relabel zero-sample rows as measured again
    expect(lb).not.toContain('measured_tps_label: "Measured TPS"');
  });
  it("leaderboard UI renders the API label and an unranked marker (#11)", () => {
    const ui = readFileSync("frontend/src/components/Leaderboard.tsx", "utf8");
    expect(ui).toContain("measured_tps_label");
    expect(ui).toContain('r.rank ?? "—"');
  });
  it("leaderboard query does not scan raw per request — uses hourly stats", async () => {
    const routes = readFileSync("src/api/leaderboard.ts", "utf8");
    expect(routes).toContain("hourly_model_stats");
    expect(routes).toContain("parseRange");
    expect(routes).toContain("is_stale");
  });
});
