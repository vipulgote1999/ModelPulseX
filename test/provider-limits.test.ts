import { describe, it, expect } from "vitest";
import { PROVIDER_REGISTRY, freeTierFor } from "../src/providers/registry";

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
