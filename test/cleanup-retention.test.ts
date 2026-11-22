/** Retention hygiene: login_attempts rows under the cap have blocked_until
 *  NULL, so the old blocked-only predicate never pruned them. The 15-minute
 *  throttle window is the real expiry. */
import { describe, expect, it } from "vitest";
import { cleanupRetention } from "../src/db/queries";

function fakeDb() {
  const sql: string[] = [];
  return {
    sql,
    prepare(stmt: string) {
      sql.push(stmt);
      return {
        bind() {
          return { sql: stmt };
        },
      };
    },
    async batch() {
      return [];
    },
  };
}

describe("cleanupRetention", () => {
  it("prunes login buckets by last attempt, not only active blocks", async () => {
    const db = fakeDb();
    await cleanupRetention(db as never, 7, 30);
    const login = db.sql.find((s) => /DELETE FROM login_attempts/.test(s));
    expect(login).toContain("last_attempt_at");
    expect(login).not.toContain("blocked_until IS NOT NULL");
  });

  it("keeps the raw/hourly/tenmin cutoffs parameterized", async () => {
    const db = fakeDb();
    await cleanupRetention(db as never, 7, 30);
    for (const table of ["benchmark_runs", "hourly_model_stats", "tenmin_model_stats"]) {
      const del = db.sql.find((s) => new RegExp(`DELETE FROM ${table}`).test(s));
      expect(del).toContain("?");
    }
  });
});
