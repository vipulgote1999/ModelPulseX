import { describe, it, expect } from "vitest";
import { selectJobs, withUsageOffset, normalizeCapabilities, type SelectableModel, type SelectionConfig } from "../src/utils/scheduler-select";

function model(id: number, provider: string, last: string | null, caps?: string[] | string | null): SelectableModel {
  return { id, display_name: `m${id}`, provider_model_id: `pm${id}`, provider, last_benchmark: last, capabilities: caps ?? null };
}

function cfg(overrides: Partial<SelectionConfig> = {}): SelectionConfig {
  return {
    maxGlobal: 100,
    capFor: () => 10,
    rpmLimitFor: () => 100,
    providerCooldowns: new Set(),
    modelCooldowns: new Set(),
    rpmUsage: new Map(),
    benchmarkType: "short",
    nowMs: 1_000_000_000_000,
    tierIntervalMsFor: () => 0,
    ...overrides,
  };
}

describe("scheduler-select — pure job selection", () => {
  it("returns empty for empty input", () => {
    const r = selectJobs([], cfg());
    expect(r.jobs).toEqual([]);
    expect(r.skippedCooldown).toBe(0);
    expect(r.skippedRPM).toBe(0);
  });

  it("propagates benchmark type into every job", () => {
    const r = selectJobs([model(1, "groq", null)], cfg({ benchmarkType: "coding" }));
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.benchmark_type).toBe("coding");
  });

  it("round-robins across providers instead of draining one", () => {
    // Input pre-sorted LRU: a1 older than b1 etc. Interleave providers in the sort order.
    const models = [model(1, "a", null), model(3, "b", null), model(2, "a", "2026-01-01"), model(4, "b", "2026-01-01")];
    const r = selectJobs(models, cfg());
    expect(r.jobs.map((j) => j.model_id)).toEqual([1, 3, 2, 4]);
  });

  it("orders never-benchmarked providers before benchmarked ones regardless of name", () => {
    const models = [model(1, "zeta", "2026-01-02"), model(2, "alpha", null)];
    const r = selectJobs(models, cfg());
    expect(r.jobs[0]!.provider).toBe("alpha");
  });

  it("counts provider-cooldown skips", () => {
    const models = [model(1, "groq", null), model(2, "openrouter", null)];
    const r = selectJobs(models, cfg({ providerCooldowns: new Set(["groq"]) }));
    expect(r.jobs.map((j) => j.provider)).toEqual(["openrouter"]);
    expect(r.skippedCooldown).toBe(1);
  });

  it("counts model-cooldown skips separately from provider skips", () => {
    const models = [model(1, "groq", null), model(2, "groq", null)];
    const r = selectJobs(models, cfg({ modelCooldowns: new Set([2]) }));
    expect(r.jobs).toHaveLength(1);
    expect(r.skippedCooldown).toBe(1);
  });

  it("respects RPM budget from prior usage", () => {
    const r = selectJobs([model(1, "groq", null)], cfg({ rpmUsage: new Map([["groq", 30]]), rpmLimitFor: () => 30 }));
    expect(r.jobs).toHaveLength(0);
    expect(r.skippedRPM).toBe(1);
  });

  it("stops picking a provider once jobs taken this tick consume its RPM budget", () => {
    const models = [model(1, "groq", null), model(2, "groq", null)];
    const r = selectJobs(models, cfg({ rpmLimitFor: () => 1 }));
    expect(r.jobs).toHaveLength(1);
  });

  it("enforces per-provider concurrency caps", () => {
    const models = [model(1, "groq", null), model(2, "groq", null), model(3, "groq", null)];
    const r = selectJobs(models, cfg({ capFor: (p) => (p === "groq" ? 1 : 10) }));
    expect(r.jobs.filter((j) => j.provider === "groq")).toHaveLength(1);
  });

  it("stops at the global cap", () => {
    const models = Array.from({ length: 10 }, (_, i) => model(i + 1, "groq", null));
    const r = selectJobs(models, cfg({ maxGlobal: 3 }));
    expect(r.jobs).toHaveLength(3);
  });

  it("skips models benchmarked within their tier interval (counts skippedCadence)", () => {
    const now = Date.parse("2026-10-12T13:00:00Z");
    const fresh = "2026-10-12T12:50:00Z"; // 10m ago
    const stale = "2026-10-12T10:00:00Z"; // 3h ago
    const models = [model(1, "opencode_go", fresh), model(2, "opencode_go", stale), model(3, "opencode_go", null)];
    const r = selectJobs(models, cfg({ nowMs: now, tierIntervalMsFor: () => 30 * 60_000 }));
    expect(r.jobs.map((j) => j.model_id)).toEqual([3, 2]);
    expect(r.skippedCadence).toBe(1);
  });

  it("honors slow-cadence capability via the interval callback", () => {
    const now = Date.parse("2026-10-12T13:00:00Z");
    const hourAgo = "2026-10-12T12:00:00Z";
    const models = [
      model(1, "opencode_go", hourAgo, ["text", "slow-cadence"]),
      model(2, "opencode_go", hourAgo, ["text"]),
    ];
    const r = selectJobs(models, cfg({
      nowMs: now,
      tierIntervalMsFor: (_p, caps) => (caps?.includes("slow-cadence") ? 360 * 60_000 : 30 * 60_000),
    }));
    expect(r.jobs.map((j) => j.model_id)).toEqual([2]);
    expect(r.skippedCadence).toBe(1);
  });

  it("parses D1 JSON-TEXT capabilities for cadence resolution", () => {
    const now = Date.parse("2026-10-12T13:00:00Z");
    const hourAgo = "2026-10-12T12:00:00Z";
    const models = [model(1, "opencode_go", hourAgo, JSON.stringify(["text", "slow-cadence"]))];
    const r = selectJobs(models, cfg({
      nowMs: now,
      tierIntervalMsFor: (_p, caps) => (caps?.includes("slow-cadence") ? 360 * 60_000 : 30 * 60_000),
    }));
    expect(r.jobs).toHaveLength(0);
    expect(r.skippedCadence).toBe(1);
  });

  it("never skips on unparseable timestamps", () => {
    const r = selectJobs(
      [{ ...model(1, "groq", null), last_benchmark: "not-a-date" }],
      cfg({ nowMs: 1_000_000_000_000, tierIntervalMsFor: () => 60_000 }),
    );
    expect(r.jobs).toHaveLength(1);
    expect(r.skippedCadence).toBe(0);
  });

  it("withUsageOffset deducts taken jobs from the budget", () => {
    const usage = withUsageOffset(new Map([["groq", 1]]), [{ provider: "groq" }, { provider: "openrouter" }]);
    expect(usage.get("groq")).toBe(2);
    expect(usage.get("openrouter")).toBe(1);
  });

  it("normalizeCapabilities handles arrays, JSON text, and junk", () => {
    expect(normalizeCapabilities(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeCapabilities(JSON.stringify(["slow-cadence"]))).toEqual(["slow-cadence"]);
    expect(normalizeCapabilities(null)).toBeUndefined();
    expect(normalizeCapabilities("{oops")).toBeUndefined();
  });
});
