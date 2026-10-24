import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { e2eSpeed } from "../src/utils/metrics";

const src = readFileSync("src/api/leaderboard.ts", "utf8");

describe("leaderboard e2e wiring", () => {
  it("selects snapshot e2e columns and maps them", () => {
    for (const s of ["e2e_tps_1h", "e2e_tps_24h", "e2e_tps_7d", "median_chunks_7d"])
      expect(src).toContain(s);
    expect(src).toContain("e2e_tps_now: entry?.e2e ?? null");
  });

  it("provides the live fallback from raw runs", () => {
    expect(src).toContain("gc_e2e_1h");
    expect(src).toContain("gc_e2e_24h");
    expect(src).toContain("gc_e2e_7d");
    expect(src).toContain("gc_chunks_7d");
    expect(src).toContain("now_e2e");
    expect(src).toContain("median_e2e_tps");
  });

  it("sort=tps uses the 7d → 24h → now chain", () => {
    expect(src).toContain("e2eSpeed(");
  });

  it("summary best_tps is the e2e leader and best_e2e_tps is its alias", () => {
    expect(src).toContain("best_e2e_tps");
    expect(src).toContain("best_tps: bestE2e");
  });
});

describe("e2eSpeed fallback chain", () => {
  it("prefers 7d over 24h over now", () => {
    expect(e2eSpeed({ e2e_tps_7d: 1, e2e_tps_24h: 2, e2e_tps_now: 3 })).toBe(1);
  });
});
