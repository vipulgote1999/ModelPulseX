import { describe, it, expect, vi, afterEach } from "vitest";
import { PerformanceDO } from "../src/live/performance-do";

function makeDO() {
  const setAlarm = vi.fn().mockResolvedValue(undefined);
  const state = { storage: { setAlarm } } as unknown as DurableObjectState;
  const do_ = new PerformanceDO(state, {});
  return { do_, setAlarm };
}

const SSE = { accept: "text/event-stream" };

describe("PerformanceDO", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects SSE from disallowed origins", async () => {
    const { do_ } = makeDO();
    const res = await do_.fetch(
      new Request("https://live/live", {
        headers: { ...SSE, origin: "https://evil.test" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("echoes ACAO for every allowed origin (incl. 127.0.0.1:8787)", async () => {
    // Regression: the gate allowed these origins but the echo used a smaller
    // hardcoded list, so browsers blocked the stream.
    for (const origin of [
      "https://modelpulsex.vipulgote5.workers.dev",
      "http://127.0.0.1:8787",
      "http://localhost:8787",
    ]) {
      const { do_ } = makeDO();
      const res = await do_.fetch(
        new Request("https://live/live", { headers: { ...SSE, origin } }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      await res.body?.cancel();
    }
  });

  it("rejects external publish without the internal header", async () => {
    const { do_ } = makeDO();
    const res = await do_.fetch(
      new Request("https://live/publish", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "1.2.3.4",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "benchmark.completed" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("accepts internal publish and reports client count", async () => {
    const { do_ } = makeDO();
    const pub = await do_.fetch(
      new Request("https://live/publish", {
        method: "POST",
        headers: {
          "x-mpulse-internal": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "benchmark.completed" }),
      }),
    );
    expect(pub.status).toBe(200);
    const clients = await do_.fetch(new Request("https://live/clients"));
    expect(await clients.json()).toEqual({ clients: 0 });
  });

  it("idle alarm does not reschedule itself", async () => {
    const { do_, setAlarm } = makeDO();
    await do_.alarm();
    expect(setAlarm).not.toHaveBeenCalled();
  });
});
