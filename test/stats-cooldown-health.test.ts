import { describe, it, expect } from "vitest";
import { escalatedDurationMs } from "../src/db/cooldown";
import { shouldAlertStale } from "../src/db/health";
import { parseConcatNumbers, percentile, MIN_SAMPLES } from "../src/utils/metrics";
import { retryAfterSeconds } from "../src/utils/concurrency";

describe("cooldown escalation math", () => {
  const BASE = 60_000;
  const MAX = 2 * 60 * 60 * 1000;

  it("uses base duration when no cooldown is active", () => {
    expect(escalatedDurationMs(null, BASE, MAX)).toBe(BASE);
    expect(escalatedDurationMs(0, BASE, MAX)).toBe(BASE);
    expect(escalatedDurationMs(-5, BASE, MAX)).toBe(BASE);
  });

  it("doubles remaining time while a cooldown is active", () => {
    expect(escalatedDurationMs(BASE, BASE, MAX)).toBe(2 * BASE);
  });

  it("caps at max", () => {
    expect(escalatedDurationMs(MAX, BASE, MAX)).toBe(MAX);
  });
});

describe("staleness watchdog decision", () => {
  const NOW = Date.parse("2026-08-25T18:00:00Z");

  it("fresh data never alerts", () => {
    const d = shouldAlertStale("2026-08-25T17:45:00Z", 0, 30, NOW);
    expect(d.stale).toBe(false);
    expect(d.alertDue).toBe(false);
    expect(d.ageMinutes).toBe(15);
  });

  it("stale data with no prior alert is due", () => {
    const d = shouldAlertStale("2026-08-25T03:56:00Z", 0, 30, NOW);
    expect(d.stale).toBe(true);
    expect(d.alertDue).toBe(true);
  });

  it("rate-limits repeat alerts to one per hour", () => {
    const lastAlert = Date.parse("2026-08-25T17:30:00Z");
    const d = shouldAlertStale("2026-08-25T03:56:00Z", lastAlert, 30, NOW);
    expect(d.stale).toBe(true);
    expect(d.alertDue).toBe(false); // only 30m since last alert
  });

  it("allows another alert after an hour has passed", () => {
    const lastAlert = Date.parse("2026-08-25T16:00:00Z");
    const d = shouldAlertStale("2026-08-25T03:56:00Z", lastAlert, 30, NOW);
    expect(d.alertDue).toBe(true);
  });

  it("never-benchmarked DB reports stale without alert math", () => {
    const d = shouldAlertStale(null, 0, 30, NOW);
    expect(d.stale).toBe(true);
    expect(d.ageMinutes).toBeNull();
    expect(d.alertDue).toBe(false);
  });
});

describe("GROUP_CONCAT parsing + percentiles", () => {
  it("parses clean positive numbers from concat strings", () => {
    expect(parseConcatNumbers("12.5,,30,0")).toEqual([12.5, 30]);
    expect(parseConcatNumbers(null)).toEqual([]);
    expect(parseConcatNumbers("")).toEqual([]);
    expect(parseConcatNumbers("-3,nan,7")).toEqual([7]);
  });

  it("percentile picks order statistics correctly", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 100], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 90)).toBe(100);
  });

  it("minimum-sample thresholds gate small windows hardest", () => {
    expect(MIN_SAMPLES.w1h).toBeLessThanOrEqual(MIN_SAMPLES.w24h);
    expect(MIN_SAMPLES.w24h).toBeLessThanOrEqual(MIN_SAMPLES.w7d);
  });
});

describe("Retry-After header handling", () => {
  it("parses integer seconds", () => {
    const res = new Response(null, { status: 429, headers: { "retry-after": "120" } });
    expect(retryAfterSeconds(res)).toBe(120);
  });

  it("falls back to jittered default when header missing", () => {
    const res = new Response(null, { status: 429 });
    const v = retryAfterSeconds(res);
    expect(v).toBeGreaterThanOrEqual(1);
    expect(v).toBeLessThanOrEqual(3600);
  });
});
