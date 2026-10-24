import { describe, it, expect } from "vitest";
import { parseHash, parseCompareIds, formatHash, MAX_COMPARE } from "../frontend/src/lib/router";

describe("hash router (e04s04)", () => {
  it("parses the dashboard with a compare selection", () => {
    expect(parseHash("#/?compare=1,2,3")).toEqual({ page: "dashboard", modelId: null, compare: [1, 2, 3] });
    expect(parseHash("")).toEqual({ page: "dashboard", modelId: null, compare: [] });
    expect(parseHash("#/")).toEqual({ page: "dashboard", modelId: null, compare: [] });
  });

  it("parses static pages", () => {
    for (const p of ["models", "pricing", "vs", "methodology", "docs", "admin"]) {
      expect(parseHash("#/" + p)).toEqual({ page: p, modelId: null, compare: [] });
    }
  });

  it("parses model detail ids and rejects junk", () => {
    expect(parseHash("#/model/42")).toEqual({ page: "model", modelId: 42, compare: [] });
    expect(parseHash("#/model/0").page).toBe("dashboard");
    expect(parseHash("#/model/abc").page).toBe("dashboard");
    expect(parseHash("#/nope")).toEqual({ page: "dashboard", modelId: null, compare: [] });
  });

  it("strict-parses compare ids (positive ints, deduped, capped)", () => {
    expect(parseCompareIds(null)).toEqual([]);
    expect(parseCompareIds("")).toEqual([]);
    expect(parseCompareIds("1,2,2,3")).toEqual([1, 2, 3]);
    expect(parseCompareIds("1.5,-2,abc,4")).toEqual([4]);
    expect(parseCompareIds("1,2,3,4,5,6,7,8")).toHaveLength(MAX_COMPARE);
    expect(MAX_COMPARE).toBe(6);
  });

  it("round-trips the leaderboard TPS view", () => {
    expect(parseHash("#/?tps_view=e2e").tpsView).toBe("e2e");
    expect(parseHash("#/?tps_view=decode").tpsView).toBe("decode");
    expect(parseHash("#/?tps_view=junk").tpsView).toBeUndefined();
    expect(
      formatHash({ page: "dashboard", modelId: null, compare: [1], tpsView: "e2e" }),
    ).toBe("#/?compare=1&tps_view=e2e");
    expect(
      formatHash({ page: "dashboard", modelId: null, compare: [1], tpsView: "both" }),
    ).toBe("#/?compare=1");
  });

  it("round-trips hashes", () => {
    expect(formatHash({ page: "dashboard", modelId: null, compare: [1, 2] })).toBe("#/?compare=1,2");
    expect(formatHash({ page: "dashboard", modelId: null, compare: [] })).toBe("#/");
    expect(formatHash({ page: "model", modelId: 7, compare: [] })).toBe("#/model/7");
    expect(formatHash({ page: "pricing", modelId: null, compare: [] })).toBe("#/pricing");
    expect(parseHash(formatHash({ page: "dashboard", modelId: null, compare: [5] }))).toEqual({
      page: "dashboard",
      modelId: null,
      compare: [5],
    });
  });
});
