import { describe, it, expect } from "vitest";
import { PROVIDER_REGISTRY, freeTierFor } from "../src/providers/registry";
import { getConcurrency, capFor, getRPMConfig, rpmForProvider } from "../src/utils/concurrency";

describe("provider free tier descriptors", () => {
  it("exposes a documented free tier for every registered provider", () => {
    for (const d of PROVIDER_REGISTRY) {
      expect(d.freeTier, `missing freeTier for ${d.name}`).toBeDefined();
    }
  });

  it("never reports a negative or zero limit", () => {
    for (const d of PROVIDER_REGISTRY) {
      const t = d.freeTier;
      if (!t) continue;
      for (const k of ["rpm", "rpd", "tokensPerDay"] as const) {
        const v = t[k];
        if (v != null) expect(v, `${d.name}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it("resolves unknown providers to null", () => {
    expect(freeTierFor("does_not_exist")).toBeNull();
  });
});

describe("provider concurrency and RPM keys (e04s02)", () => {
  it("resolves caps for the new providers with safe defaults", () => {
    const c = getConcurrency({});
    expect(capFor("opencode_go", c)).toBe(2);
    expect(capFor("ollama_pro", c)).toBe(2);
    expect(capFor("ollama", c)).toBe(2);
  });

  it("honors env overrides for the new providers", () => {
    const c = getConcurrency({ MAX_OPENCODE_GO_CONCURRENCY: "5", MAX_OLLAMA_PRO_CONCURRENCY: "1" });
    expect(capFor("opencode_go", c)).toBe(5);
    expect(capFor("ollama_pro", c)).toBe(1);
  });

  it("resolves RPM budgets for the new providers", () => {
    const r = getRPMConfig({});
    expect(rpmForProvider("opencode_go", r)).toBe(10);
    expect(rpmForProvider("ollama_pro", r)).toBe(10);
  });
});
