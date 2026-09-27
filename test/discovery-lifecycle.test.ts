import { describe, it, expect } from "vitest";
import { markMissingInactive } from "../src/db/queries";

type Row = {
  provider_id: number;
  provider_model_id: string;
  free_status: string;
  active: number;
  benchmark_enabled: number;
  last_seen: string;
};

// Minimal D1 stub that actually applies the inactive UPDATE to in-memory
// rows, so tests assert resulting state (not SQL shape).
function fakeDb(seed: Row[]) {
  const statements: string[] = [];
  const db = {
    statements,
    prepare(sql: string) {
      statements.push(sql);
      let params: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          params = a;
          return stmt;
        },
        all: async () => {
          if (sql.includes("FROM models WHERE provider_id=? AND active=1")) {
            return {
              results: seed
                .filter(
                  (r) => r.provider_id === params[0] && r.active === 1,
                )
                .map((r) => ({ provider_model_id: r.provider_model_id })),
            };
          }
          return { results: [] };
        },
        first: async () => null,
        run: async () => {
          if (sql.startsWith("UPDATE models SET active=0")) {
            const [now, pid, ...ids] = params as [
              string,
              number,
              ...string[],
            ];
            for (const r of seed) {
              if (r.provider_id !== pid || r.active !== 1) continue;
              if (ids.length > 0 && !ids.includes(r.provider_model_id))
                continue;
              r.active = 0;
              if (r.free_status === "FREE") r.free_status = "PREVIOUSLY_FREE";
              r.last_seen = now;
            }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

const NOW = "2026-09-27T07:00:00.000Z";

describe("discovery lifecycle — enable preservation", () => {
  it("missing models go inactive/PREVIOUSLY_FREE but keep benchmark_enabled", async () => {
    const seed: Row[] = [
      {
        provider_id: 7,
        provider_model_id: "gone:free",
        free_status: "FREE",
        active: 1,
        benchmark_enabled: 1,
        last_seen: "old",
      },
      {
        provider_id: 7,
        provider_model_id: "stays:free",
        free_status: "FREE",
        active: 1,
        benchmark_enabled: 1,
        last_seen: "old",
      },
      {
        provider_id: 7,
        provider_model_id: "admin-off:free",
        free_status: "FREE",
        active: 1,
        benchmark_enabled: 0,
        last_seen: "old",
      },
    ];
    const db = fakeDb(seed);
    await markMissingInactive(
      db as never,
      7,
      new Set(["stays:free", "admin-off:free"]),
      NOW,
    );
    const gone = seed[0]!;
    expect(gone.active).toBe(0);
    expect(gone.free_status).toBe("PREVIOUSLY_FREE");
    expect(gone.benchmark_enabled).toBe(1);
    expect(gone.last_seen).toBe(NOW);
    // untouched rows keep everything
    expect(seed[1]).toMatchObject({ active: 1, free_status: "FREE" });
    expect(seed[2]!.benchmark_enabled).toBe(0);
    // no statement may reference the enable flag
    expect(
      db.statements.some((s) => s.includes("benchmark_enabled")),
    ).toBe(false);
  });

  it("empty discovery fails safe: inactive flip, enable flags intact", async () => {
    const seed: Row[] = [
      {
        provider_id: 9,
        provider_model_id: "a:free",
        free_status: "FREE",
        active: 1,
        benchmark_enabled: 1,
        last_seen: "old",
      },
    ];
    const db = fakeDb(seed);
    await markMissingInactive(db as never, 9, new Set(), NOW);
    expect(seed[0]).toMatchObject({
      active: 0,
      free_status: "PREVIOUSLY_FREE",
      benchmark_enabled: 1,
    });
    expect(
      db.statements.some((s) => s.includes("benchmark_enabled")),
    ).toBe(false);
  });
});
