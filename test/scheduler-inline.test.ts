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
