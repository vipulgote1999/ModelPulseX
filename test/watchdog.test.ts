import { describe, it, expect, vi, afterEach } from "vitest";
import { watchdogCheck } from "../src/db/health";

// Minimal D1 stub: serves MAX(started_at) + scheduler_health reads, records writes.
function mockDb(lastBenchmark: string | null, lastAlert: string | null) {
  const writes: string[] = [];
  const db = {
    writes,
    prepare(sql: string) {
      // Mirror the D1 statement shape: first/run callable directly or after bind().
      const first = async () => {
        if (sql.includes("MAX(started_at)")) return { m: lastBenchmark };
        return { last_stale_alert_at: lastAlert };
      };
      const run = async () => {
        writes.push(sql);
        return { meta: { changes: 1 } };
      };
      return {
        bind(..._args: unknown[]) {
          return { first, run };
        },
        first,
        run,
      };
    },
  };
  return db;
}

const OLD = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); // 3h stale
const NOW = Date.now();

describe("watchdogCheck alert accounting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not stamp or claim alert when no webhook is configured", async () => {
    const db = mockDb(OLD, null);
    const r = await watchdogCheck(db as never, {}, NOW);
    expect(r.stale).toBe(true);
    expect(r.alerted).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it("does not stamp when the send fails (retry next tick)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("conn refused");
      }),
    );
    const db = mockDb(OLD, null);
    const r = await watchdogCheck(
      db as never,
      { ALERT_WEBHOOK_URL: "https://hooks.test/x" },
      NOW,
    );
    expect(r.stale).toBe(true);
    expect(r.alerted).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it("stamps only after a delivered send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const db = mockDb(OLD, null);
    const r = await watchdogCheck(
      db as never,
      { ALERT_WEBHOOK_URL: "https://hooks.test/x" },
      NOW,
    );
    expect(r.alerted).toBe(true);
    expect(db.writes.length).toBe(1);
    expect(db.writes[0]).toContain("last_stale_alert_at");
  });
});
