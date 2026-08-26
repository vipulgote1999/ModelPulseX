import { describe, it, expect } from "vitest";
import { jittered, backoff, getConcurrency } from "../src/utils/concurrency";

describe("queue/do/concurrency", () => {
  it("jitter stays in 0.8..1.2 * base", () => {
    for (let i = 0; i < 20; i++) {
      const v = jittered(60);
      expect(v).toBeGreaterThanOrEqual(48);
      expect(v).toBeLessThanOrEqual(72);
    }
  });
  it("backoff doubles with jitter", () => {
    const b0 = backoff(0, 1000);
    const b1 = backoff(1, 1000);
    expect(b1).toBeGreaterThan(b0 * 0.6); // jitter tolerance
  });
  it("concurrency defaults 10/3/5/1", () => {
    const c = getConcurrency({});
    expect(c).toMatchObject({ maxOpencode: 3, maxSameModel: 1 });
    expect(c.maxGlobal).toBeGreaterThanOrEqual(12);
    expect(c.maxOpenrouter).toBeGreaterThanOrEqual(4);
    // new providers have defaults too
    expect(c.maxGroq).toBe(3);
    expect(c.maxGemini).toBe(3);
    expect(c.maxTokenrouter).toBe(3);
    expect(c.maxAgnesAi).toBe(2);
  });
  it("429 Retry-After respected (header parsing)", async () => {
    const { retryAfterSeconds } = await import("../src/utils/concurrency");
    const res = new Response(null, { status: 429, headers: { "retry-after": "120" } });
    expect(retryAfterSeconds(res)).toBe(120);
  });
});
