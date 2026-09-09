import { describe, it, expect } from "vitest";
import {
  AUTO_DISABLE_DAILY_MAX_DEFAULT,
  countDayFailures,
  escalatedModelCooldownMs,
  isGoneModelErrorText,
  MODEL_COOLDOWN_CAP_MS,
  shouldAutoDisable,
} from "../src/utils/auto-disable";

describe("auto-disable — 24h failure accounting", () => {
  it("counts failures over trailing 24h, ignores SUCCESS", () => {
    const rows = [
      { status: "SUCCESS" },
      { status: "TIMEOUT" },
      { status: "PROVIDER_ERROR", error_type: "boom", http_status: 500 },
      { status: "SUCCESS" },
    ];
    expect(countDayFailures(rows)).toEqual({ failures: 2, goneHits: 0 });
  });

  it("detects gone-model signals (404, not supported, unavailable)", () => {
    expect(isGoneModelErrorText("Model x is not supported")).toBe(true);
    expect(
      isGoneModelErrorText("Upstream request failed: Model is unavailable."),
    ).toBe(true);
    expect(isGoneModelErrorText("OpenCode's free tier can only be used")).toBe(
      false,
    );
    expect(isGoneModelErrorText(null)).toBe(false);
    const rows = [
      { status: "PROVIDER_ERROR", error_type: "Model x is not supported", http_status: 401 },
    ];
    expect(countDayFailures(rows)).toEqual({ failures: 1, goneHits: 1 });
    const via404 = [{ status: "MODEL_UNAVAILABLE", http_status: 404 }];
    expect(countDayFailures(via404)).toEqual({ failures: 1, goneHits: 1 });
  });

  it("disables on 2 gone-hits or daily-max failures", () => {
    expect(shouldAutoDisable(1, 2, 10).disable).toBe(true);
    expect(shouldAutoDisable(10, 0, 10).disable).toBe(true);
    expect(shouldAutoDisable(9, 0, 10).disable).toBe(false);
    expect(shouldAutoDisable(1, 1, 10).disable).toBe(false);
    expect(AUTO_DISABLE_DAILY_MAX_DEFAULT).toBe(10);
  });

  it("escalates model cooldown with doubling backoff capped at 24h", () => {
    const m = 60_000;
    expect(escalatedModelCooldownMs(m, 0)).toBe(m);
    expect(escalatedModelCooldownMs(m, 1)).toBe(m);
    expect(escalatedModelCooldownMs(m, 2)).toBe(2 * m);
    expect(escalatedModelCooldownMs(m, 3)).toBe(4 * m);
    expect(escalatedModelCooldownMs(m, 100)).toBe(MODEL_COOLDOWN_CAP_MS);
    expect(MODEL_COOLDOWN_CAP_MS).toBe(24 * 60 * 60 * 1000);
  });
});
