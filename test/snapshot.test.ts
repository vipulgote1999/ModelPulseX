import { describe, it, expect } from "vitest";
import { buildSnapshotRows, nowFor } from "../src/db/snapshot";
import type { SnapshotMeta, SnapshotRaw, SnapshotSpark } from "../src/db/snapshot";

const models: SnapshotMeta[] = [
  {
    id: 1,
    provider_model_id: "a:free",
    display_name: "A",
    free_status: "FREE",
    active: 1,
    provider: "pa",
  },
  {
    id: 2,
    provider_model_id: "b:free",
    display_name: "B",
    free_status: "FREE",
    active: 1,
    provider: "pb",
  },
];

function rawRow(
  model_id: number,
  benchmark_type: string,
  vals: number[],
  ok?: number,
): SnapshotRaw {
  const gc = vals.join(",");
  const n = vals.length;
  return {
    model_id,
    benchmark_type,
    cnt_1h: n,
    g_tps_1h: gc,
    g_ttft_1h: gc,
    cnt_24h: n,
    g_tps_24h: gc,
    g_ttft_24h: gc,
    cnt7: n,
    g_tps_7d: gc,
    g_ttft_7d: gc,
    g_itl_7d: gc,
    ok_7d: ok ?? n,
    tot_7d: n,
  };
}

describe("buildSnapshotRows", () => {
  it("computes gated medians per window", () => {
    // 6 samples → passes every gate (1h:2, 24h:3, 7d:5). The project's
    // percentile() takes the lower middle on even counts: median(1..6) = 3.
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [rawRow(1, "coding", [1, 2, 3, 4, 5, 6])],
      spark: [],
      nowIso: new Date().toISOString(),
    });
    const coding = rows.find(
      (r) => r.model_id === 1 && r.benchmark === "coding",
    )!;
    expect(coding.tps_7d).toBeCloseTo(3);
    expect(coding.tps_24h).toBeCloseTo(3);
    expect(coding.tps_1h).toBeCloseTo(3);
    expect(coding.uptime_7d).toBeCloseTo(1);
    expect(coding.error_rate_7d).toBeCloseTo(0);
    expect(coding.sample_count_24h).toBe(6);
    expect(coding.request_count_7d).toBe(6);
  });

  it("nulls windows below min-sample gates", () => {
    // 3 samples: 1h(2)✓ 24h(3)✓ 7d(5)✗
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [rawRow(1, "coding", [10, 20, 30], 2)],
      spark: [],
      nowIso: new Date().toISOString(),
    });
    const coding = rows.find(
      (r) => r.model_id === 1 && r.benchmark === "coding",
    )!;
    expect(coding.tps_1h).toBeCloseTo(20);
    expect(coding.tps_24h).toBeCloseTo(20);
    expect(coding.tps_7d).toBeNull();
    expect(coding.uptime_7d).toBeNull();
  });

  it("merges benchmark types for the all view", () => {
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [
        rawRow(1, "coding", [100, 100, 100, 100, 100, 100]),
        rawRow(1, "coding", [200, 200, 200, 200, 200, 200]),
      ],
      spark: [],
      nowIso: new Date().toISOString(),
    });
    const all = rows.find((r) => r.model_id === 1 && r.benchmark === "all")!;
    // merged 12 samples (six 100s, six 200s) → lower middle = 100
    expect(all.tps_7d).toBeCloseTo(100);
    expect(all.sample_count_24h).toBe(12);
  });

  it("emits null rows for models with no runs, for every benchmark", () => {
    const rows = buildSnapshotRows({
      models,
      raw: [rawRow(1, "coding", [5, 6, 7, 8, 9, 10])],
      spark: [],
      nowIso: new Date().toISOString(),
    });
    // 2 models × 2 benchmarks (all + coding)
    expect(rows.length).toBe(4);
    const b = rows.filter((r) => r.model_id === 2);
    expect(b.length).toBe(2);
    expect(b.every((r) => r.tps_7d == null && r.uptime_7d == null)).toBe(true);
  });

  it("builds per-type sparklines capped at 24 points, averaged for all", () => {
    const spark: SnapshotSpark[] = [];
    for (let h = 0; h < 30; h++) {
      const t = `2026-09-0${h < 10 ? "1" : "2"}T${String(h % 24).padStart(2, "0")}:00:00.000Z`;
      spark.push({ model_id: 1, benchmark_type: "coding", hour_start: t, v: 10 });
    }
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [],
      spark,
      nowIso: new Date().toISOString(),
    });
    const coding = rows.find(
      (r) => r.model_id === 1 && r.benchmark === "coding",
    )!;
    const all = rows.find((r) => r.model_id === 1 && r.benchmark === "all")!;
    expect((JSON.parse(coding.sparkline) as number[]).length).toBe(24);
    expect(JSON.parse(coding.sparkline) as number[]).toEqual(
      Array(24).fill(10),
    );
    // single prompt: all view mirrors the coding sparkline, last 24
    expect(JSON.parse(all.sparkline) as number[]).toEqual(Array(24).fill(10));
  });
});

describe("nowFor", () => {
  const json = JSON.stringify({
    short: { tps: 10, ttft: 5, itl: 1, status: "SUCCESS", at: "2026-09-05T10:00:00.000Z" },
    medium: { tps: 20, ttft: 6, itl: 2, status: "TIMEOUT", at: "2026-09-05T11:00:00.000Z" },
  });
  it("picks the requested benchmark entry", () => {
    expect(nowFor(json, "short")?.tps).toBe(10);
    expect(nowFor(json, "coding")).toBeNull();
  });
  it("picks the newest entry for the all view", () => {
    expect(nowFor(json, "all")?.tps).toBe(20);
  });
  it("tolerates null and corrupt JSON", () => {
    expect(nowFor(null, "all")).toBeNull();
    expect(nowFor("{", "short")).toBeNull();
  });
});
