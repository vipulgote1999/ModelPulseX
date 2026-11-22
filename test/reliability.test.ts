import { describe, expect, it } from "vitest";
import {
  HOUR_UP_THRESHOLD,
  hoursUpPercent,
} from "../frontend/src/lib/reliability";

describe("reliability timeline summary", () => {
  it("uses the same >=50% threshold as the green bars", () => {
    expect(HOUR_UP_THRESHOLD).toBe(0.5);
    expect(
      hoursUpPercent([
        { success_rate: 1 },
        { success_rate: 0.8 },
        { success_rate: 0.5 },
        { success_rate: 0.4 },
        { success_rate: null },
      ]),
    ).toBe(60);
  });

  it("returns null for an empty series instead of 0%", () => {
    expect(hoursUpPercent([])).toBeNull();
  });

  it("reports a fully healthy week as 100%", () => {
    expect(
      hoursUpPercent(Array.from({ length: 76 }, () => ({ success_rate: 1 }))),
    ).toBe(100);
  });
});
