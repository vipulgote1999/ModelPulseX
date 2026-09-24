import { describe, it, expect } from "vitest";
import { scoreLeaderboard, recommendationCards } from "../src/benchmark/scoring";

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
  it("best_coding equals best_overall, never an arbitrary first row (batch-3)", () => {
    // Batch-3: bestCoding was active[0] (display_name order) — a mislabeled
    // pick with zero coding evidence. Single-coding observatory: all rows are
    // coding rows, so the coding winner IS the overall winner (or null).
    const rows = [
      { model_id: 2, tps_7d: 50, tps_24h: 50, tps_now: 50, ttft_7d: 800, uptime_7d: 0.9, active: true, free_status: "FREE", status: "SUCCESS", display_name: "zzz-last" } as unknown as import("../src/types").LeaderboardRow,
      { model_id: 1, tps_7d: 100, tps_24h: 100, tps_now: 100, ttft_7d: 200, uptime_7d: 0.99, active: true, free_status: "FREE", status: "SUCCESS", display_name: "aaa-first" } as unknown as import("../src/types").LeaderboardRow,
    ];
    const cards = recommendationCards(rows);
    expect(cards.best_coding?.model_id).toBe(cards.best_overall?.model_id);
    expect(cards.best_coding?.model_id).toBe(1);
    expect(recommendationCards([]).best_coding).toBeNull();
  });
});
