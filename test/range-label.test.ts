import { describe, expect, it } from "vitest";
import { bucketLabel, rangeLabel } from "../frontend/src/lib/rangeLabel";

describe("range labels", () => {
  it("labels each selector window", () => {
    expect(rangeLabel("1h")).toBe("1-hour");
    expect(rangeLabel("24h")).toBe("24-hour");
    expect(rangeLabel("3d")).toBe("3-day");
    expect(rangeLabel("7d")).toBe("7-day");
  });

  it("falls back to the default window instead of leaking a raw value", () => {
    expect(rangeLabel(undefined)).toBe("7-day");
    expect(rangeLabel("bogus")).toBe("7-day");
  });

  it("labels the aggregate granularity", () => {
    expect(bucketLabel("1h")).toBe("10m buckets");
    expect(bucketLabel("24h")).toBe("hourly aggregates");
  });
});
