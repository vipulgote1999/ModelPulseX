import { describe, it, expect } from "vitest";
import { getAA, getAAMeta, INTELLIGENCE_ENTRIES } from "../frontend/src/lib/intelligence";

describe("intelligence metadata (e04s03)", () => {
  it("hits exact aliases", () => {
    expect(getAAMeta("kimi-k3")?.score).toBe(43.6);
    expect(getAAMeta("gpt-oss:120b")?.score).toBe(11.6);
  });

  it("resolves -free and :free variants via normalization", () => {
    expect(getAAMeta("muse-spark-1.3-contributor-free")?.score).toBe(48.1);
    expect(getAAMeta("mimo-v2.6-flash-free")?.score).toBe(37.9);
    expect(getAAMeta("google/gemma-4-31b-it:free")?.score).toBe(14.7);
  });

  it("is case-insensitive", () => {
    expect(getAAMeta("Kimi-K3")?.score).toBe(43.6);
  });

  it("returns null for unknown ids", () => {
    expect(getAAMeta("nope-not-a-model")).toBeNull();
    expect(getAA("nope-not-a-model")).toBeNull();
  });

  it("OR-merges thinking, false reasoning wins", () => {
    expect(getAAMeta("kimi-k3")?.thinking).toBe(true);
    expect(getAAMeta("deepseek-v4-flash")?.thinking).toBeNull();
    expect(getAAMeta("mistral-large-3:675b")?.thinking).toBe(false);
    expect(getAAMeta("nemotron-3-nano:30b")?.reasoningModel).toBe(false);
    expect(getAAMeta("gemma4:31b")?.reasoningModel).toBe(true);
  });

  it("every entry is sane (score range, AA url, aliases)", () => {
    expect(INTELLIGENCE_ENTRIES.length).toBeGreaterThan(30);
    for (const e of INTELLIGENCE_ENTRIES) {
      expect(e.score).toBeGreaterThan(0);
      expect(e.score).toBeLessThanOrEqual(100);
      expect(e.url?.startsWith("https://artificialanalysis.ai/models/")).toBe(true);
      expect(e.aliases.length).toBeGreaterThan(0);
    }
  });

  it("getAA stays compatible (score+url only)", () => {
    expect(getAA("kimi-k3")).toEqual({ score: 43.6, url: "https://artificialanalysis.ai/models/kimi-k3" });
  });
});
