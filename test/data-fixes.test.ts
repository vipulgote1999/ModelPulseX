/** One-shot data fixes are applied exactly once by the scheduler. The
 *  2026-11-22 fix closes incidents for models that will never run again
 *  (auto-disabled or no longer free) — otherwise an outage opened in August
 *  still reads as "ongoing" in the public incident history.
 */
import { describe, expect, it } from "vitest";
import { applyDataFixes } from "../src/db/data-fixes";

function fakeDb() {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  return {
    sql,
    binds,
    prepare(stmt: string) {
      sql.push(stmt);
      const obj = {
        bind(...args: unknown[]) {
          binds.push(args);
          return obj;
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return obj;
    },
  };
}

describe("availability incident data fix", () => {
  it("closes open incidents for disabled and no-longer-free models", async () => {
    const db = fakeDb();
    const applied = await applyDataFixes(db as never);
    expect(applied).toContain("2026-11-22_close_incidents_for_retired_models");
    const close = db.sql.find(
      (s) => /UPDATE availability_incidents/.test(s) && /ended_at IS NULL/.test(s),
    );
    expect(close).toContain("benchmark_enabled");
    expect(close).toContain("free_status!='FREE'");
    expect(close).toContain("MAX(br.started_at)");
    const duration = db.sql.find(
      (s) => /duration_seconds/.test(s) && /julianday\(ended_at\)/.test(s),
    );
    expect(duration).toContain("MAX(0");
  });
});
