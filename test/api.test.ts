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
  it("leaderboard meta carries scheduler heartbeat + alert channel for the banner", () => {
    // Batch-2: the dashboard tick chip (last_schedule_ms) and log-only alert
    // chip both read leaderboard meta — if finish() drops either key the
    // banner silently loses them. Pin the wiring, not the values.
    const lb = readFileSync("src/api/leaderboard.ts", "utf8");
    expect(lb).toContain("scheduler: sched");
    expect(lb).toContain("alert_channel: alertChannelState(env)");
    const hook = readFileSync("frontend/src/hooks/useLeaderboard.ts", "utf8");
    expect(hook).toContain("last_schedule_ms");
    expect(hook).toContain("alert_channel");
  });
  it("compare parses strict positive-int ids, deduped (batch-3)", () => {
    // Batch-3: map(Number).filter(Boolean) let "1.5"→1, "-1"→-1, "1,1,2"
    // doubled rows through. Pin the strict parse at the source.
    const src = readFileSync("src/api/compare.ts", "utf8");
    expect(src).toContain("Number.isInteger(n) && n > 0");
    expect(src).toContain("new Set(");
  });
  it("health rejects non-numeric freshness instead of defaulting (batch-3)", () => {
    // Batch-3: ?freshness=abc silently became 15m — monitors passed quietly on
    // typos. Pin the 400 at the source.
    const src = readFileSync("src/api/health.ts", "utf8");
    expect(src).toContain("invalid freshness");
  });
  it("incidents validates integer id like the sibling route (batch-3)", () => {
    // Batch-3: /models/abc/incidents ran 4 queries with NaN → 200
    // null-uptime. Pin the up-front 400.
    const src = readFileSync("src/api/models.ts", "utf8");
    expect(src).toContain("Number.isInteger(id)");
  });
});
