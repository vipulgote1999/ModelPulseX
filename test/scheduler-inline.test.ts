import { describe, it, expect, vi } from "vitest";
import { runInlineBounded, INLINE_BUDGET_MS } from "../src/benchmark/scheduler";

/** Issue #26: the 5-minute scheduler tick ran up to 6 jobs inline, each allowed the
 *  300s coding provider timeout, so a tick could overrun the cron interval — the
 *  heartbeat (written last) went stale and ticks overlapped. `runInlineBounded`
 *  bounds the inline work and hands everything unrun back to the caller to queue,
 *  so a timeout can never drop a job. */

describe("runInlineBounded (issue #26)", () => {
  it("runs up to `take` jobs while inside the budget and queues the rest", async () => {
    const order: number[] = [];
    const { ran, rest } = await runInlineBounded(
      [1, 2, 3, 4, 5],
      2,
      INLINE_BUDGET_MS,
      async (j) => {
        order.push(j);
      },
    );
    expect(ran).toBe(2);
    expect(order).toEqual([1, 2]);
    // jobs 3-5 are returned for the queue — never silently dropped
    expect(rest).toEqual([3, 4, 5]);
  });

  it("stops starting new jobs once the wall-clock budget is spent, keeping the rest", async () => {
    let clock = 0;
    const order: number[] = [];
    const now = () => clock;
    const { ran, rest } = await runInlineBounded(
      [1, 2, 3, 4],
      4, // asked for all four
      1000, // but only 1s of budget
      async (j) => {
        order.push(j);
        clock += 600; // each job takes 600ms
      },
      { now },
    );
    // job 1 (0→600), job 2 (600→1200): after job 2 the budget is spent, so 3 and 4 queue
    expect(order).toEqual([1, 2]);
    expect(ran).toBe(2);
    expect(rest).toEqual([3, 4]);
  });

  it("still runs the first job even if the budget is zero — progress over perfection", async () => {
    const order: number[] = [];
    const { ran, rest } = await runInlineBounded(
      [1, 2],
      2,
      0,
      async (j) => {
        order.push(j);
      },
    );
    // budget 0 means "do not start" — nothing runs, everything queues
    expect(ran).toBe(0);
    expect(order).toEqual([]);
    expect(rest).toEqual([1, 2]);
  });

  it("a failing job is reported and does not abort the remaining inline work", async () => {
    const onError = vi.fn();
    const done: number[] = [];
    const { ran, rest } = await runInlineBounded(
      [1, 2, 3],
      3,
      INLINE_BUDGET_MS,
      async (j) => {
        if (j === 2) throw new Error("provider exploded");
        done.push(j);
      },
      { onError },
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(done).toEqual([1, 3]);
    expect(ran).toBe(2);
    // the failed job is not re-queued (unchanged behaviour: it is logged, the queue
    // path has its own retries) — but it is also not counted as run
    expect(rest).toEqual([]);
  });

  it("writes the heartbeat even when queue sendBatch throws (2026-09-24 prod stall)", async () => {
    // Prod evidence: last_schedule_at froze at 01:51 UTC while
    // last_schedule_started_at advanced every 5 min — the completed-tick write
    // was skipped on any throw before it. The finally-guaranteed heartbeat must
    // record the tick's partial counts instead of a frozen timestamp.
    const { scheduleBenchmarks } = await import("../src/benchmark/scheduler");
    const statements: string[] = [];
    const heartbeatPayloads: Array<{
      enqueueCount: number;
      inlineCount: number;
      skippedCooldown: number;
      skippedRpm: number;
    }> = [];
    const fakeDb = {
      prepare(sql: string) {
        statements.push(sql);
        const stmt = {
          bind(...args: unknown[]) {
            // recordScheduleTick binds (now, enqueue, inline, skippedCd, skippedRpm, ms, now)
            if (sql.includes("last_schedule_at") && args.length === 7) {
              heartbeatPayloads.push({
                enqueueCount: args[1] as number,
                inlineCount: args[2] as number,
                skippedCooldown: args[3] as number,
                skippedRpm: args[4] as number,
              });
            }
            return stmt;
          },
          all: async () => {
            if (sql.includes("FROM models")) {
              return {
                results: [
                  {
                    id: 1,
                    display_name: "m1",
                    provider_model_id: "m1",
                    provider: "groq",
                    last_benchmark: null,
                  },
                ],
              };
            }
            if (sql.includes("provider_cooldowns")) return { results: [] };
            if (sql.includes("model_cooldowns")) return { results: [] };
            if (sql.includes("FROM benchmark_runs"))
              return { results: [], meta: { rows_read: 0 } };
            return { results: [] };
          },
          first: async () => {
            if (sql.includes("RETURNING rows_read")) return { rows_read: 0 };
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
        };
        return stmt;
      },
    };
    const env = {
      DB: fakeDb,
      // Queue explodes on sendBatch: without the finally-guarantee the heartbeat
      // below would never run and last_schedule_at would freeze.
      BENCH_QUEUE: {
        sendBatch: async () => {
          throw new Error("queue exploded");
        },
      },
      MAX_GLOBAL_CONCURRENCY: "40",
    };
    const res = await scheduleBenchmarks(env as never, { inlineTake: 0 });
    // one job selected (fake model), nothing enqueued (queue threw), no throw out
    expect(res.selected).toBe(1);
    expect(res.enqueued).toBe(0);
    // start-heartbeat ran, and — the regression — the completed heartbeat ran too
    expect(statements.some((q) => q.includes("last_schedule_started_at"))).toBe(
      true,
    );
    expect(heartbeatPayloads.length).toBe(1);
    expect(heartbeatPayloads[0]).toEqual({
      enqueueCount: 0,
      inlineCount: 0,
      skippedCooldown: 0,
      skippedRpm: 0,
    });
  });

  it("never loses a job: ran + rest always accounts for the input", async () => {
    let clock = 0;
    const jobs = Array.from({ length: 9 }, (_, i) => i);
    const { ran, rest } = await runInlineBounded(
      jobs,
      9,
      5,
      async () => {
        clock += 2;
      },
      { now: () => clock },
    );
    expect(ran + rest.length).toBe(jobs.length);
  });
});
