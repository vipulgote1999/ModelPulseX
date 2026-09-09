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
});
