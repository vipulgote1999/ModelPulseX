import { describe, it, expect, vi, afterEach } from "vitest";
import {
  utcDay,
  rowsReadAlertDue,
  alertFraction,
  rowsCap,
  recordRowsRead,
  getRowsReadToday,
  checkRowsReadBudget,
  D1_FREE_TIER_ROWS_PER_DAY,
} from "../src/db/query-cost";

/** Minimal D1 stub: serves one day row, records writes, reports `changes`. */
function stubDb(row: unknown, opts: { changes?: number; throwOnRead?: boolean } = {}) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    writes,
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          writes.push({ sql, binds });
          return {
            first: async () => {
              if (opts.throwOnRead) throw new Error("D1_ERROR: no such table: rows_read_daily");
              return row;
            },
            run: async () => ({ meta: { changes: opts.changes ?? 1 } }),
          };
        },
      };
    },
  };
  return db;
}

const HIGH_ROW = {
  day: "2026-09-10",
  rows_read: 4_500_000,
  top_shape: "provider-count",
  top_rows: 4_400_000,
};
const LOW_ROW = { ...HIGH_ROW, rows_read: 10 };

describe("rows-read accounting (issue #12)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("buckets by UTC day", () => {
    expect(utcDay(Date.parse("2026-09-10T23:59:59Z"))).toBe("2026-09-10");
    expect(utcDay(Date.parse("2026-09-11T00:00:01Z"))).toBe("2026-09-11");
  });

  it("alert fires at the configured fraction of the cap, not before", () => {
    const cap = D1_FREE_TIER_ROWS_PER_DAY;
    expect(rowsReadAlertDue(0, 0.8, cap)).toBe(false);
    expect(rowsReadAlertDue(3_999_999, 0.8, cap)).toBe(false);
    expect(rowsReadAlertDue(4_000_000, 0.8, cap)).toBe(true);
    expect(rowsReadAlertDue(5_000_000, 0.8, cap)).toBe(true);
    // a nonsense fraction falls back to the documented 0.8 default
    expect(rowsReadAlertDue(4_000_000, NaN, cap)).toBe(true);
    // a bad cap must not produce a permanent alert
    expect(rowsReadAlertDue(4_000_000, 0.8, 0)).toBe(false);
  });

  it("reads fraction and cap from env with defaults", () => {
    expect(alertFraction({})).toBe(0.8);
    expect(alertFraction({ ROWS_READ_ALERT_FRACTION: "0.5" })).toBe(0.5);
    expect(alertFraction({ ROWS_READ_ALERT_FRACTION: "-1" })).toBe(0.8);
    expect(rowsCap({})).toBe(D1_FREE_TIER_ROWS_PER_DAY);
    expect(rowsCap({ D1_DAILY_ROWS_CAP: "100" })).toBe(100);
  });

  it("accumulates measured shapes with an upsert and reports the new total", async () => {
    const db = stubDb({ ...HIGH_ROW, rows_read: 123 });
    const total = await recordRowsRead(
      db as never,
      [
        { shape: "provider-count", rowsRead: 100 },
        { shape: "failure-buckets", rowsRead: 23 },
      ],
      Date.parse("2026-09-10T12:00:00Z"),
    );
    expect(total).toBe(123);
    // one row per day, accumulated in SQL — not one row per measurement
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.sql).toContain("ON CONFLICT(day) DO UPDATE");
    expect(db.writes[0]!.binds[1]).toBe(123); // this tick's measured total
    expect(db.writes[0]!.binds[2]).toBe("provider-count"); // top shape
  });

  it("ignores empty/zero measurements instead of writing a no-op row", async () => {
    const db = stubDb(HIGH_ROW);
    expect(await recordRowsRead(db as never, [], Date.now())).toBeNull();
    expect(
      await recordRowsRead(db as never, [{ shape: "x", rowsRead: 0 }], Date.now()),
    ).toBeNull();
    expect(db.writes).toEqual([]);
  });

  it("survives a missing table (pre-migration deploy)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = stubDb(null, { throwOnRead: true });
    expect(
      await recordRowsRead(db as never, [{ shape: "provider-count", rowsRead: 5 }]),
    ).toBeNull();
    expect(await getRowsReadToday(db as never)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("claims the daily alert slot atomically and reports on the shared channel", async () => {
    const db = stubDb(HIGH_ROW, { changes: 1 });
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        posted.push(String(init?.body ?? ""));
        return new Response("ok", { status: 200 });
      }),
    );
    const res = await checkRowsReadBudget(
      db as never,
      { ALERT_WEBHOOK_URL: "https://hooks.test/x" },
      Date.parse("2026-09-10T12:00:00Z"),
    );
    expect(res).toEqual({
      measured: HIGH_ROW.rows_read,
      cap: D1_FREE_TIER_ROWS_PER_DAY,
      alerted: true,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("rows-read budget");
    expect(posted[0]).toContain("provider-count");
  });

  it("stays quiet when another tick already claimed today's alert", async () => {
    // changes: 0 == the `WHERE alerted_at IS NULL` guard matched nothing
    const db = stubDb(HIGH_ROW, { changes: 0 });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await checkRowsReadBudget(
      db as never,
      { ALERT_WEBHOOK_URL: "https://hooks.test/x" },
      Date.parse("2026-09-10T12:00:00Z"),
    );
    expect(res?.alerted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not alert below the threshold and never throws without a table", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const low = await checkRowsReadBudget(stubDb(LOW_ROW) as never, {}, Date.now());
    expect(low).toEqual({
      measured: LOW_ROW.rows_read,
      cap: D1_FREE_TIER_ROWS_PER_DAY,
      alerted: false,
    });
    // no table → today's row is unavailable → no decision, no throw, and NO log:
    // this path runs on every /api/health probe, so it must stay quiet.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await checkRowsReadBudget(stubDb(null, { throwOnRead: true }) as never, {}, Date.now()),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
