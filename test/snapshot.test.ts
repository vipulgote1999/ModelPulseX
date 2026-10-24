import { describe, it, expect } from "vitest";
import fs from "node:fs";

import { buildSnapshotRows, nowFor, refreshLeaderboardSnapshot } from "../src/db/snapshot";
import type {
  SnapshotMeta,
  SnapshotRaw,
  SnapshotSpark,
} from "../src/db/snapshot";

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
    g_e2e_1h: gc,
    g_ttft_1h: gc,
    cnt_24h: n,
    g_tps_24h: gc,
    g_e2e_24h: gc,
    g_ttft_24h: gc,
    cnt7: n,
    g_tps_7d: gc,
    g_e2e_7d: gc,
    g_ttft_7d: gc,
    g_itl_7d: gc,
    g_chunks_7d: gc,
    ok_7d: ok ?? n,
    tot_7d: n,
    ok_24h: ok ?? n,
    tot_24h: n,
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
    expect(coding.uptime_24h).toBeCloseTo(1);
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
    // 24h gate (3) passes with 3 samples: 2/3 success
    expect(coding.uptime_24h).toBeCloseTo(2 / 3);
  });

  it("nulls uptime_24h below the 24h min-sample gate", () => {
    // 2 samples: 24h gate (3) fails even though all succeeded
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [rawRow(1, "coding", [10, 20])],
      spark: [],
      nowIso: new Date().toISOString(),
    });
    const coding = rows.find(
      (r) => r.model_id === 1 && r.benchmark === "coding",
    )!;
    expect(coding.uptime_24h).toBeNull();
    expect(coding.sample_count_24h).toBe(2);
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
    // 2 models × 3 benchmarks (all + coding + speed)
    expect(rows.length).toBe(6);
    const b = rows.filter((r) => r.model_id === 2);
    expect(b.length).toBe(3);
    expect(b.every((r) => r.tps_7d == null && r.uptime_7d == null)).toBe(true);
  });

  it("builds per-type sparklines capped at 24 points, averaged for all", () => {
    const spark: SnapshotSpark[] = [];
    for (let h = 0; h < 30; h++) {
      const t = `2026-09-0${h < 10 ? "1" : "2"}T${String(h % 24).padStart(2, "0")}:00:00.000Z`;
      spark.push({
        model_id: 1,
        benchmark_type: "coding",
        hour_start: t,
        v: 10,
      });
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

  it("computes gated e2e medians and chunk median", () => {
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [rawRow(1, "coding", [10, 20, 30, 40, 50, 60])],
      spark: [], nowIso: new Date().toISOString(),
    });
    const coding = rows.find((r) => r.model_id === 1 && r.benchmark === "coding")!;
    expect(coding.e2e_tps_1h).toBeCloseTo(30);
    expect(coding.e2e_tps_24h).toBeCloseTo(30);
    expect(coding.e2e_tps_7d).toBeCloseTo(30);
    expect(coding.median_chunks_7d).toBeCloseTo(30);
  });

  it("nulls e2e and chunk medians below their gates", () => {
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [rawRow(1, "coding", [10, 20, 30], 2)],
      spark: [], nowIso: new Date().toISOString(),
    });
    const coding = rows.find((r) => r.model_id === 1 && r.benchmark === "coding")!;
    expect(coding.e2e_tps_1h).toBeCloseTo(20);
    expect(coding.e2e_tps_7d).toBeNull();
    // chunk median gates on SUCCESS count (ok_7d = 2), not total count (3)
    expect(coding.median_chunks_7d).toBeNull();
  });

  it("merges e2e values across benchmark types for the all view", () => {
    const rows = buildSnapshotRows({
      models: [models[0]!],
      raw: [rawRow(1, "coding", [100, 100]), rawRow(1, "speed", [300, 300])],
      spark: [], nowIso: new Date().toISOString(),
    });
    const all = rows.find((r) => r.model_id === 1 && r.benchmark === "all")!;
    expect(all.e2e_tps_1h).toBeCloseTo(100); // lower middle of four values
  });
});

describe("refreshLeaderboardSnapshot sweep (2026-09-24 prod: dead row ranked #1)", () => {
  function fakeDb(rows: { benchmark: string; model_id: number }[], stale: { benchmark: string; model_id: number }[]) {
    // Minimal D1 stub: batch() serves the three reads, then records upserts;
    // prepare() outside batch serves the sweep DELETE and counts its victims.
    const upserted: string[] = [];
    let deleted = 0;
    const deletedKeys: string[] = [];
    const db = {
      upserted,
      get deleted() { return deleted; },
      get deletedKeys() { return deletedKeys; },
      prepare(sql: string) {
        const stmt = {
          bind(..._a: unknown[]) { return stmt; },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => {
            if (sql.startsWith("DELETE FROM leaderboard_snapshot")) {
              // victims = stale fixture rows never refreshed by this tick
              deleted = stale.length;
              for (const r of stale) deletedKeys.push(r.benchmark + ":" + r.model_id);
            }
            return { meta: { changes: deleted } };
          },
        };
        return stmt;
      },
      batch: async (stmts: unknown[]) => {
        // First call: the 3-statement read batch. Later calls: upsert chunks.
        void stmts;
        const calls = (db as unknown as { n: number }).n ?? 0;
        (db as unknown as { n: number }).n = calls + 1;
        if (calls === 0) {
          return [
            { results: [{ id: 1, provider_model_id: "a:free", display_name: "A", free_status: "FREE", active: 1, provider: "pa" }] },
            { results: [] },
            { results: [] },
          ];
        }
        upserted.push("chunk");
        return [{ meta: {} }];
      },
    };
    return db;
  }

  it("deletes snapshot rows this tick did not refresh", async () => {
    // Regression: disabled stealth/union-alpha kept its last snapshot row and
    // ranked #1 with status UNKNOWN + zero 7d runs, because nothing ever
    // deleted rows for models excluded from the refresh query.
    const db = fakeDb([{ benchmark: "all", model_id: 1 }], [{ benchmark: "all", model_id: 58084 }]);
    const res = await refreshLeaderboardSnapshot(db as never, Date.now());
    expect(res.models).toBe(1);
    expect(db.upserted.length).toBeGreaterThan(0);
    expect(db.deleted).toBe(1);
    expect(db.deletedKeys).toEqual(["all:58084"]);
  });
});

describe("refreshLeaderboardSnapshot e2e binds", () => {
  it("binds e2e medians and the chunk median into the upsert", async () => {
    const upserts: Array<{ sql: string; args: unknown[] }> = [];
    let reads = 0;
    const db = {
      prepare(sql: string) {
        const stmt = {
          sql,
          args: [] as unknown[],
          bind(...a: unknown[]) { stmt.args = a; return stmt; },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } }),
        };
        if (sql.includes("INSERT INTO leaderboard_snapshot")) upserts.push(stmt);
        return stmt;
      },
      batch: async () => {
        const call = reads++;
        if (call === 0) return [
          { results: [{ id: 1, provider_model_id: "a:free", display_name: "A", free_status: "FREE", active: 1, provider: "pa" }] },
          { results: [rawRow(1, "coding", [10, 20, 30, 40, 50, 60])] },
          { results: [] },
        ];
        return [{ meta: {} }];
      },
    };
    await refreshLeaderboardSnapshot(db as never, Date.now());
    const all = upserts.find((u) => u.args[0] === "all")!;
    expect(all.sql).toContain("median_chunks_7d");
    expect(all.sql).toContain("e2e_tps_7d");
    // ... e2e_tps_1h, e2e_tps_24h, e2e_tps_7d, median_chunks_7d, snapshot_at
    expect(all.args.slice(-5)).toEqual([30, 30, 30, 30, expect.any(String)]);
  });
});

describe("overlayStatus (2026-09-24 prod: UNKNOWN was a join artifact)", () => {
  it("keeps a genuinely reported status, including UNKNOWN", async () => {
    const { overlayStatus } = await import("../src/api/leaderboard");
    expect(overlayStatus("SUCCESS", true)).toBe("SUCCESS");
    expect(overlayStatus("UNKNOWN", true)).toBe("UNKNOWN");
  });
  it("returns null when the overlay row is missing (no measurement)", async () => {
    // orcarouter/free: 35 24h samples, snapshot row present, overlay row
    // filtered by benchmark_enabled=0 — UNKNOWN + last_test null was the
    // artifact. Null lets the windowed medians speak instead of a fake status.
    const { overlayStatus } = await import("../src/api/leaderboard");
    expect(overlayStatus(null, false)).toBeNull();
  });
});

describe("refreshLeaderboardSnapshot empty-refresh guard", () => {
  it("skips the sweep when models/raw come back empty", async () => {
    // Hazard: an outage-shaped empty refresh (no models, no raw) must not
    // DELETE the whole snapshot table — stale beats empty for an observatory.
    const { refreshLeaderboardSnapshot } = await import("../src/db/snapshot");
    let deletes = 0;
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind(..._a: unknown[]) { return stmt; },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => {
            if (sql.startsWith("DELETE FROM leaderboard_snapshot")) deletes++;
            return { meta: { changes: 0 } };
          },
        };
        return stmt;
      },
      batch: async () => [{ results: [] }, { results: [] }, { results: [] }],
    };
    const res = await refreshLeaderboardSnapshot(db as never, Date.now());
    expect(res.models).toBe(0);
    expect(res.rows).toBe(0);
    expect(deletes).toBe(0);
  });
});

describe("leaderboard overlay coverage (2026-09-24 loop-8)", () => {
  it("keys the overlay by snapshot ids, not the servable-models filter", async () => {
    // Regression: disabled stealth/union-alpha ranked #1 with status null
    // while a SUCCESS overlay sat unread in models.last_now_json — the overlay
    // query filtered benchmark_enabled=1 but the snapshot row survived.
    // The overlay SELECT must scope by snapshot model_ids so every served row
    // gets its latest-run data regardless of current servability.
    const src = fs.readFileSync("src/api/leaderboard.ts", "utf8");
    expect(src).toContain("WHERE m.id IN (SELECT model_id FROM leaderboard_snapshot");
    expect(src).not.toMatch(/last_now_json FROM models[\s\S]{0,300}?COALESCE\(m\.benchmark_enabled/);
  });
});

describe("nowFor", () => {
  const json = JSON.stringify({
    short: {
      tps: 10,
      ttft: 5,
      itl: 1,
      status: "SUCCESS",
      at: "2026-09-05T10:00:00.000Z",
    },
    medium: {
      tps: 20,
      ttft: 6,
      itl: 2,
      status: "TIMEOUT",
      at: "2026-09-05T11:00:00.000Z",
    },
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
  it("nowFor carries e2e and old JSON yields null via the reader", () => {
    const withE2e = JSON.stringify({
      coding: { tps: 100, e2e: 40, ttft: 200, itl: 5, status: "SUCCESS", at: "2026-10-24T00:00:00.000Z" },
    });
    expect(nowFor(withE2e, "coding")?.e2e).toBe(40);
    const old = JSON.stringify({
      coding: { tps: 100, ttft: 200, itl: 5, status: "SUCCESS", at: "2026-10-24T00:00:00.000Z" },
    });
    expect(nowFor(old, "coding")?.e2e ?? null).toBeNull();
  });
});
