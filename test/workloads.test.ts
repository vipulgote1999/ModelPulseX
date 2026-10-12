import { describe, expect, it } from "vitest";
import { WORKLOADS } from "../src/benchmark/workloads";

// Floor guards: thinking models burn budget on reasoning before answering,
// so the single coding workload must carry headroom against truncation
// (finish_reason=length with zero/partial content).
describe("workload budget floors", () => {
  it("coding budget is at least 4092 tokens with room to finish", () => {
    expect(WORKLOADS.coding.max_tokens).toBeGreaterThanOrEqual(4092);
    // Timeout must cover a full-budget generation at modest speed:
    // 4092 tokens at ~13.6 TPS ≈ 300s. Slower than that records TIMEOUT.
    expect(WORKLOADS.coding.timeout_ms).toBeGreaterThanOrEqual(300_000);
  });

  // Sampling is pinned so cron and the playground measure identical
  // conditions — a silent drift here splits leaderboard history.
  it("coding pins top_p 0.95 (matches playground default)", () => {
    expect(WORKLOADS.coding.top_p).toBe(0.95);
  });
});

// TokenDyno-parity speed probe (e04s01): identical prompt + 300-token cap.
describe("speed workload (TokenDyno parity)", () => {
  it("uses the fixed HTTP-routing prose prompt with a 300-token cap", () => {
    expect(WORKLOADS.speed.prompt).toContain("HTTP request routing");
    expect(WORKLOADS.speed.max_tokens).toBe(300);
  });
  it("pins top_p 0.95 and a 60s timeout", () => {
    expect(WORKLOADS.speed.top_p).toBe(0.95);
    expect(WORKLOADS.speed.timeout_ms).toBe(60000);
  });
});
