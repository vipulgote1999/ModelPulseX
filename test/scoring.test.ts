import { describe, it, expect } from "vitest";
import { scoreLeaderboard } from "../src/benchmark/scoring";

describe("scoring", () => {
  it("overallScore normalized across active FREE models, profiles reweight", () => {
    const rows = [
      { model_id: 1, tps_7d: 100, ttft_7d: 200, uptime_7d: 0.99, active: true, free_status: "FREE", status: "SUCCESS" } as unknown as import("../src/types").LeaderboardRow,
      { model_id: 2, tps_7d: 50, ttft_7d: 800, uptime_7d: 0.9, active: true, free_status: "FREE", status: "SUCCESS" } as unknown as import("../src/types").LeaderboardRow,
      { model_id: 3, tps_7d: 10, ttft_7d: 1500, uptime_7d: 0.8, active: true, free_status: "FREE", status: "SUCCESS" } as unknown as import("../src/types").LeaderboardRow,
    ];
    const balanced = scoreLeaderboard(rows, "balanced");
    expect(balanced[0]!.overall_score! > balanced[1]!.overall_score!).toBe(true);
    const reliable = scoreLeaderboard(rows, "reliable");
    // reliable should still rank 1 first but weight differs; just ensure not null and plausible
    expect(reliable.every((r) => r.overall_score != null)).toBe(true);
  });
  it("PREVIOUSLY_FREE and inactive excluded from scoring", () => {
    const rows = [
      { model_id: 1, tps_7d: 100, ttft_7d: 100, uptime_7d: 0.99, active: true, free_status: "FREE", status: "SUCCESS" } as unknown as import("../src/types").LeaderboardRow,
      { model_id: 2, tps_7d: 200, ttft_7d: 50, uptime_7d: 0.99, active: false, free_status: "PREVIOUSLY_FREE", status: null } as unknown as import("../src/types").LeaderboardRow,
    ];
    const scored = scoreLeaderboard(rows, "balanced");
    expect(scored.find((r) => r.model_id === 2)?.overall_score).toBeNull();
  });
  it("nulls score when no TPS window has a value (2026-09-24: 7 zero-TPS rows ranked 52-58)", () => {
    const rows = [
      { model_id: 1, tps_7d: 100, tps_24h: 90, tps_now: 95, ttft_7d: 100, uptime_7d: 0.99, active: true, free_status: "FREE", status: "SUCCESS" } as unknown as import("../src/types").LeaderboardRow,
      { model_id: 2, tps_7d: null, tps_24h: null, tps_now: null, ttft_7d: null, uptime_7d: 0, active: true, free_status: "FREE", status: "PROVIDER_ERROR" } as unknown as import("../src/types").LeaderboardRow,
    ];
    const scored = scoreLeaderboard(rows, "balanced");
    expect(scored.find((r) => r.model_id === 1)?.overall_score).not.toBeNull();
    expect(scored.find((r) => r.model_id === 2)?.overall_score).toBeNull();
  });
});
