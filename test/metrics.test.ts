import { describe, it, expect } from "vitest";
import { computeTPS, computeTTFT, computeGenerationMs, percentile, overallScore, normalizeScores } from "../src/utils/metrics";

describe("metrics", () => {
  it("TTFT = first - started", () => {
    expect(computeTTFT(1000, 1120)).toBe(120);
    expect(computeTTFT(1000, null)).toBeNull();
  });
  it("generation = completed - first", () => {
    expect(computeGenerationMs(1120, 3120)).toBe(2000);
    expect(computeGenerationMs(null, 3120)).toBeNull();
  });
  it("TPS = tokens / generation_seconds, not total duration", () => {
    // 100 tokens over 2000ms = 50 TPS
    expect(computeTPS(100, 2000)).toBeCloseTo(50);
    expect(computeTPS(100, null)).toBeNull();
    expect(computeTPS(null, 2000)).toBeNull();
  });
  it("total duration trap: total 2120ms vs generation 2000ms", () => {
    const totalDuration = 2120; // started->completed
    const generation = 2000; // first->completed
    const wrong = 100 / (totalDuration / 1000); // 47.16
    const correct = 100 / (generation / 1000); // 50
    expect(wrong).not.toBeCloseTo(correct, 1);
    expect(computeTPS(100, generation)).toBeCloseTo(50);
  });
  it("percentile", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([10, 20, 30], 90)).toBe(30);
    expect(percentile([], 50)).toBeNull();
  });
  it("normalizeScores invert for ttft", () => {
    const ttft = [100, 200, 300];
    const norm = normalizeScores(ttft, true);
    expect(norm[0]).toBeCloseTo(1); // lowest ttft best
    expect(norm[2]).toBeCloseTo(0);
  });
  it("overallScore weighted", () => {
    const s = overallScore(1, 1, 1, 1, { tps: 0.4, ttft: 0.25, reliability: 0.25, consistency: 0.1 });
    expect(s).toBeCloseTo(1);
    const s2 = overallScore(0, 0, 0, 0);
    expect(s2).toBeCloseTo(0);
    expect(overallScore(null, null, null, null)).toBeNull();
  });
});
