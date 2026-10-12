import { describe, it, expect } from "vitest";
import { computeTPS, computeTTFT, computeGenerationMs, percentile, overallScore, normalizeScores, computeInterTokenLatency, computeHybridTps, measuredTpsLabel, isRankEligible, assignRanks, MIN_SAMPLES } from "../src/utils/metrics";

describe("metrics", () => {  it("TTFT = first - started", () => {
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

describe("computeInterTokenLatency", () => {
  it("returns null with fewer than two chunks", () => {
    expect(computeInterTokenLatency([])).toBeNull();
    expect(computeInterTokenLatency([100])).toBeNull();
  });
  it("returns the gap for a single pair", () => {
    expect(computeInterTokenLatency([100, 150])).toBe(50);
  });
  it("uses the median so one stall does not dominate", () => {
    expect(computeInterTokenLatency([0, 10, 20, 30, 530])).toBe(10);
  });
  it("ignores non-monotonic and nullish input", () => {
    expect(computeInterTokenLatency([50, 10])).toBeNull();
  });
});

// Issue #11: honest labels + evidence-gated ranks (no constant "Measured TPS").
describe("measuredTpsLabel", () => {
  it("labels a row with no 24h samples as having no recent data", () => {
    expect(measuredTpsLabel(0, null)).toBe("No recent data");
    expect(measuredTpsLabel(undefined, 42)).toBe("No recent data");
  });
  it("labels a gated (below-threshold) row as insufficient samples", () => {
    expect(measuredTpsLabel(2, null)).toBe("Insufficient samples");
  });
  it("labels a row with a gated-in median as measured", () => {
    expect(measuredTpsLabel(MIN_SAMPLES.w24h, 12.5)).toBe("Measured TPS");
  });
});

describe("hybrid TPS (TokenDyno parity e04s01)", () => {
  // Inter-token path: >= 8 chunks (>= 7 gaps) with mean gap > 50ms.
  it("picks inter-token timing for smooth streams", () => {
    const gaps = [60, 70, 65, 80, 75, 62, 68]; // mean ~68.6ms -> ~14.6 TPS
    const r = computeHybridTps({ outputTokens: 100, generationMs: 2000, chunkGapsMs: gaps });
    expect(r.method).toBe("inter-token");
    expect(r.tps).toBeCloseTo(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length), 1);
  });
  it("falls back to wall-clock when fewer than 8 chunks", () => {
    const r = computeHybridTps({ outputTokens: 100, generationMs: 2000, chunkGapsMs: [60, 70, 65] });
    expect(r.method).toBe("wall-clock");
    expect(r.tps).toBeCloseTo(50);
  });
  it("falls back to wall-clock for burst delivery (mean gap <= 50ms)", () => {
    const gaps = [5, 8, 3, 12, 6, 4, 9]; // burst: gaps meaningless
    const r = computeHybridTps({ outputTokens: 100, generationMs: 2000, chunkGapsMs: gaps });
    expect(r.method).toBe("wall-clock");
    expect(r.tps).toBeCloseTo(50);
  });
  it("falls back to wall-clock when no gap evidence", () => {
    const r = computeHybridTps({ outputTokens: 100, generationMs: 2000, chunkGapsMs: [] });
    expect(r.method).toBe("wall-clock");
    expect(r.tps).toBeCloseTo(50);
  });
  it("returns null (never fabricates) when tokens or generation missing", () => {
    expect(computeHybridTps({ outputTokens: null, generationMs: 2000, chunkGapsMs: [60, 70, 65, 80, 75, 62, 68] }).tps).toBeNull();
    expect(computeHybridTps({ outputTokens: 100, generationMs: null, chunkGapsMs: [60, 70, 65, 80, 75, 62, 68] }).tps).toBeNull();
  });
  it("boundary: exactly 7 gaps with mean just above 50ms uses inter-token", () => {
    const gaps = [51, 51, 51, 51, 51, 51, 51];
    const r = computeHybridTps({ outputTokens: 100, generationMs: 2000, chunkGapsMs: gaps });
    expect(r.method).toBe("inter-token");
  });
  it("boundary: mean exactly 50ms stays wall-clock", () => {
    const gaps = [50, 50, 50, 50, 50, 50, 50];
    const r = computeHybridTps({ outputTokens: 100, generationMs: 2000, chunkGapsMs: gaps });
    expect(r.method).toBe("wall-clock");
  });
});

describe("rank eligibility + assignment", () => {
  const row = (id: number, samples: number, status: string | null = "SUCCESS") => ({
    model_id: id,
    rank: 0 as number | null,
    sampleCount24h: samples,
    status,
  });

  it("requires MIN_SAMPLES.w24h runs in the last 24h plus a measured status", () => {
    // status omitted (legacy call) counts as unmeasured only when explicitly
    // null; existing callers/tests pass a real status or nothing.
    expect(isRankEligible(0, "SUCCESS")).toBe(false);
    expect(isRankEligible(2, "SUCCESS")).toBe(false);
    expect(isRankEligible(3, "SUCCESS")).toBe(true);
    expect(isRankEligible(null, "SUCCESS")).toBe(false);
    expect(isRankEligible(3, null)).toBe(false);
    expect(isRankEligible(3, undefined)).toBe(true);
  });

  it("numbers eligible rows and sinks zero-sample rows to the bottom unranked", () => {
    const ordered = assignRanks([
      row(1, 0), // zero samples — the live-board symptom from #11
      row(2, 10),
      row(3, 3),
      row(4, 1),
    ]);
    expect(ordered.map((r) => r.model_id)).toEqual([2, 3, 1, 4]);
    expect(ordered.map((r) => r.rank)).toEqual([1, 2, null, null]);
  });

  it("sinks overlay-miss rows even with samples (2026-09-24 loop-8: null-status #1)", () => {
    // Live: stealth/union-alpha ranked #1 with 4 24h samples but status null
    // (no latest-run measurement). A null status means no measurement backs
    // the rank — samples alone are not enough.
    expect(isRankEligible(4, null)).toBe(false);
    expect(isRankEligible(35, null)).toBe(false);
    expect(isRankEligible(35, "SUCCESS")).toBe(true);
    const ordered = assignRanks([row(1, 35, null), row(2, 35, "SUCCESS"), row(3, 4, null)]);
    expect(ordered.map((r) => r.model_id)).toEqual([2, 1, 3]);
    expect(ordered.map((r) => r.rank)).toEqual([1, null, null]);
  });

  it("sinks zero-TPS rows even with samples (2026-09-24 batch: 7 failure rows ranked 52-58)", () => {
    // Live: PROVIDER_ERROR/RATE_LIMITED rows with 3-6 24h samples but null in
    // every TPS window ranked on uptime residue (score gate nulled them to 5.0
    // yet they kept ranks). Rank without a speed signal is not comparable.
    const tps = (tps_now: number | null) => ({
      tps_now,
      tps_24h: null as number | null,
      tps_7d: null as number | null,
    });
    const ordered = assignRanks([
      { ...row(1, 6, "PROVIDER_ERROR"), ...tps(null) },
      { ...row(2, 6, "SUCCESS"), ...tps(100) },
    ]);
    expect(ordered.map((r) => r.model_id)).toEqual([2, 1]);
    expect(ordered.map((r) => r.rank)).toEqual([1, null]);
  });
});
