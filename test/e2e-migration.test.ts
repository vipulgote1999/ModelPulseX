import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("migration 0018 — e2e_tps", () => {
  const sql = readFileSync("migrations/0018_e2e_tps.sql", "utf8");

  it("adds every additive column", () => {
    for (const ddl of [
      "ALTER TABLE benchmark_runs ADD COLUMN e2e_tps REAL",
      "ALTER TABLE hourly_model_stats ADD COLUMN median_e2e_tps REAL",
      "ALTER TABLE tenmin_model_stats ADD COLUMN median_e2e_tps REAL",
      "ALTER TABLE leaderboard_snapshot ADD COLUMN e2e_tps_1h REAL",
      "ALTER TABLE leaderboard_snapshot ADD COLUMN e2e_tps_24h REAL",
      "ALTER TABLE leaderboard_snapshot ADD COLUMN e2e_tps_7d REAL",
      "ALTER TABLE leaderboard_snapshot ADD COLUMN median_chunks_7d REAL",
    ]) expect(sql).toContain(ddl);
  });

  it("backfills only measurable successes, with the full-request formula", () => {
    expect(sql).toContain("status = 'SUCCESS'");
    expect(sql).toContain("output_tokens > 0");
    expect(sql).toContain("julianday(completed_at) > julianday(started_at)");
    expect(sql).toContain("86400000.0");
    expect(sql).toContain("ROUND(");
    expect(sql).not.toContain("CREATE TABLE");
    expect(sql).not.toContain("DROP TABLE");
  });
});
