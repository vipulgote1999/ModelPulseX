import { describe, it, expect } from "vitest";
import { computeHourlyAggregates, computeTenminAggregates } from "../src/db/queries";

function aggregateDb(values: string | null) {
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) { stmt.args = args; return stmt; },
        run: async () => ({ meta: {} }),
        all: async () => ({
          results: sql.includes("FROM benchmark_runs")
            ? [{ model_id: 1, benchmark_type: "coding", tpss: "100,100,100",
                 e2e_tpss: values, ttfts: "100,100,100", itls: "10,10,10",
                 cnt: 3, success: 3 }]
            : [],
        }),
      };
      if (sql.includes("INSERT OR REPLACE")) inserts.push(stmt);
      return stmt;
    },
    batch: async () => [],
  };
  return { db, inserts };
}

describe("aggregateWindow — median_e2e_tps", () => {
  it("writes the e2e median for hourly buckets", async () => {
    const { db, inserts } = aggregateDb("100,300,200");
    await computeHourlyAggregates(db as never, "2026-10-24T00:00:00.000Z");
    expect(inserts[0]!.sql).toContain("median_e2e_tps");
    expect(inserts[0]!.args[17]).toBe(200);
  });

  it("preserves a genuine zero and writes tenmin medians", async () => {
    const { db, inserts } = aggregateDb("0,100");
    await computeTenminAggregates(db as never, "2026-10-24T00:10:00.000Z");
    expect(inserts[0]!.args[17]).toBe(0);
  });

  it("writes null when no e2e values exist", async () => {
    const { db, inserts } = aggregateDb(null);
    await computeHourlyAggregates(db as never, "2026-10-24T00:00:00.000Z");
    expect(inserts[0]!.args[17]).toBeNull();
  });
});
