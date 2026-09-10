import { describe, it, expect } from "vitest";
import {
  providersWithoutHardFilter,
  freeHardFilterWhere,
  ACCEPTED_FILTER_GAPS,
} from "../src/providers/registry";

/** Issue #16: `freeHardFilter` is the defence-in-depth layer that hides polluted
 *  (paid/unknown) rows from a FREE leaderboard, but only 3 of 19 descriptors declared
 *  one. These guards make the coverage gap deliberate: a provider must be filtered or
 *  explicitly excepted with a reason, so a new provider cannot silently widen the gap. */

describe("hard free-filter coverage (issue #16)", () => {
  it("every provider is either hard-filtered or an explicit accepted gap", () => {
    const undocumented = providersWithoutHardFilter().filter(
      (name) => !(name in ACCEPTED_FILTER_GAPS),
    );
    expect(
      undocumented,
      "provider declares no hardFreeFilter and no documented reason — either derive a " +
        "filter from the discovery payload or add it to ACCEPTED_FILTER_GAPS",
    ).toEqual([]);
  });

  it("every accepted gap still names an unfiltered provider (no stale entries)", () => {
    const unfiltered = new Set(providersWithoutHardFilter());
    const stale = Object.keys(ACCEPTED_FILTER_GAPS).filter(
      (name) => !unfiltered.has(name),
    );
    expect(
      stale,
      "ACCEPTED_FILTER_GAPS entry no longer applies (the provider now has a filter or " +
        "was removed) — delete it so the list keeps meaning something",
    ).toEqual([]);
  });

  it("every accepted gap states a reason", () => {
    for (const [name, reason] of Object.entries(ACCEPTED_FILTER_GAPS))
      expect(reason.length, `${name} needs a written reason`).toBeGreaterThan(30);
  });

  it("at least 8 providers now declare a hard filter (was 3 before #16)", () => {
    const filtered = 19 - providersWithoutHardFilter().length;
    expect(filtered).toBeGreaterThanOrEqual(8);
  });

  it("freeHardFilterWhere guards each filtered provider by name and skips the gaps", () => {
    const where = freeHardFilterWhere("p", "m");
    for (const name of [
      "kilocode",
      "tokenrouter",
      "ollama",
      "groq",
      "agnes_ai",
      "aionlabs",
      "glhf",
      "nscale",
    ])
      expect(where, `${name} must be guarded`).toContain(`p.name != '${name}'`);
    // providers without a filter must NOT be constrained (their rows stay visible)
    expect(where).not.toContain("p.name != 'openrouter'");
    expect(where).not.toContain("p.name != 'opencode_zen'");
  });
});
