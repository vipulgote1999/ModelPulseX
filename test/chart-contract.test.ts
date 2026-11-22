/** The methodology page promises that a missing history hour renders as a gap,
 *  not an interpolated line. Recharts only does that when connectNulls is off. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("chart history contract", () => {
  for (const file of [
    "frontend/src/charts/TpsChart.tsx",
    "frontend/src/charts/TtftChart.tsx",
    "frontend/src/charts/ItlChart.tsx",
  ]) {
    it(`${file} does not bridge missing hours`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("connectNulls");
    });
  }

  it("methodology states the gap rule", () => {
    const src = readFileSync("frontend/src/pages/Methodology.tsx", "utf8");
    expect(src).toMatch(/gap rather than an interpolated line/i);
  });
});
