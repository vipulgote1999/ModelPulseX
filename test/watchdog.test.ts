import { describe, it, expect, vi, afterEach } from "vitest";
import { watchdogCheck, alertChannelState } from "../src/db/health";

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
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = mockDb(OLD, null);
    const r = await watchdogCheck(db as never, {}, NOW);
    expect(r.stale).toBe(true);
    expect(r.alerted).toBe(false);
    expect(r.channel).toBe("log-only");
    expect(db.writes).toEqual([]);
    // Issue #22: a stall on an unconfigured channel must be loud, not silent.
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("NOT CONFIGURED");
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
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = mockDb(OLD, null);
    const r = await watchdogCheck(
      db as never,
      { ALERT_WEBHOOK_URL: "https://hooks.test/x" },
      NOW,
    );
    expect(r.alerted).toBe(true);
    expect(r.channel).toBe("configured");
    expect(err).not.toHaveBeenCalled();
    expect(db.writes.length).toBe(1);
    expect(db.writes[0]).toContain("last_stale_alert_at");
  });

  it("stays quiet when the pipeline is fresh", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = new Date(NOW - 60_000).toISOString();
    const r = await watchdogCheck(mockDb(fresh, null) as never, {}, NOW);
    expect(r.stale).toBe(false);
    expect(r.alerted).toBe(false);
    expect(err).not.toHaveBeenCalled();
  });
});

describe("alertChannelState", () => {
  it("maps the secret's presence to a channel", () => {
    expect(alertChannelState({})).toBe("log-only");
    expect(alertChannelState({ ALERT_WEBHOOK_URL: "https://hooks.test/x" })).toBe(
      "configured",
    );
  });
});
