import { describe, it, expect, vi } from "vitest";
import { classifyStatus, assertSafeApiUrl } from "../src/benchmark/engine";
import {
  computeTPS,
  computeTTFT,
  computeGenerationMs,
} from "../src/utils/metrics";

describe("benchmark engine — classification and TPS/TTFT", () => {
  it("status classification", () => {
    expect(classifyStatus(429, false, false)).toBe("RATE_LIMITED");
    expect(classifyStatus(404, false, false)).toBe("MODEL_UNAVAILABLE");
    expect(classifyStatus(500, false, false)).toBe("PROVIDER_ERROR");
    expect(classifyStatus(null, true, false)).toBe("TIMEOUT");
    expect(classifyStatus(200, false, true)).toBe("STREAM_ERROR");
    expect(classifyStatus(200, false, false)).toBe("SUCCESS");
    expect(classifyStatus(null, false, false)).toBe("UNKNOWN_ERROR");
  });

  it("correct TPS uses generation_ms not total", () => {
    const started = 0,
      first = 120,
      completed = 2120;
    const ttft = computeTTFT(started, first)!;
    const gen = computeGenerationMs(first, completed)!;
    const tps = computeTPS(100, gen)!;
    expect(ttft).toBe(120);
    expect(gen).toBe(2000);
    expect(tps).toBeCloseTo(50);
    // if mistakenly used total 2120, TPS would be ~47.16 — ensure difference
    const mistaken = 100 / ((completed - started) / 1000);
    expect(tps).not.toBeCloseTo(mistaken, 0);
  });

  it("handles missing first_token => null TPS", () => {
    expect(computeGenerationMs(null, 2120)).toBeNull();
    expect(computeTPS(100, null)).toBeNull();
  });

  it("heuristic token estimation flagged correctly (provider vs heuristic)", async () => {
    // Simulate engine behavior would set heuristic when usage missing — pure logic tested in metrics already
    // Here we just ensure engine sets method to heuristic when no usage; covered via integration with mock fetch
    const { measureBenchmark } = await import("../src/benchmark/engine");
    // Mock fetch that returns streaming success with 2 tokens, no usage
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const push = (obj: unknown) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        push({ choices: [{ delta: { content: "hi" } }] });
        push({ choices: [{ delta: { content: " there" } }] });
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const res = await measureBenchmark({
      provider: "openrouter",
      providerModelId: "test:free",
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: undefined,
      benchmark: {
        type: "short",
        prompt: "Return exactly: PONG",
        max_tokens: 16,
        timeout_ms: 5000,
      },
    } as never);
    expect(res.status).toBe("SUCCESS");
    expect(res.tps).not.toBeNull();
    expect(res.token_estimation_method).toBe("heuristic");
    expect(res.ttft_ms).not.toBeNull();
  });

  it("timeout maps to TIMEOUT status", async () => {
    const { measureBenchmark } = await import("../src/benchmark/engine");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // never resolves until abort
        await new Promise((_, rej) =>
          setTimeout(() => rej(new DOMException("Aborted", "AbortError")), 10),
        );
        return new Response(null, { status: 200 });
      }),
    );
    const res = await measureBenchmark({
      provider: "opencode_zen",
      providerModelId: "big-pickle",
      apiUrl: "https://opencode.ai/zen/v1/chat/completions",
      apiKey: undefined,
      benchmark: { type: "short", prompt: "hi", max_tokens: 8, timeout_ms: 20 },
    } as never);
    expect(res.status).toBe("TIMEOUT");
    vi.restoreAllMocks();
  });
});

describe("benchmark engine — outbound URL SSRF guard", () => {
  const base = { provider: "openrouter", providerModelId: "m:free" };

  it("allows https provider urls and http loopback only", () => {
    expect(() =>
      assertSafeApiUrl("https://openrouter.ai/api/v1/chat/completions"),
    ).not.toThrow();
    expect(() =>
      assertSafeApiUrl("https://api.groq.com/openai/v1/chat/completions"),
    ).not.toThrow();
    expect(() =>
      assertSafeApiUrl("http://localhost:11434/v1/chat/completions"),
    ).not.toThrow();
    expect(() =>
      assertSafeApiUrl("http://127.0.0.1:8789/v1/chat/completions"),
    ).not.toThrow();
  });

  it("blocks plaintext-remote, credentials and fragments", () => {
    expect(() =>
      assertSafeApiUrl("http://evil.example.com/v1/chat/completions"),
    ).toThrow(/blocked/);
    expect(() =>
      assertSafeApiUrl("https://user:pass@openrouter.ai/api/v1"),
    ).toThrow(/blocked/);
    expect(() => assertSafeApiUrl("https://openrouter.ai/api/v1#frag")).toThrow(
      /blocked/,
    );
    expect(() => assertSafeApiUrl("not a url")).toThrow(/blocked/);
  });

  it("measureBenchmark records UNKNOWN_ERROR without calling fetch on blocked url", async () => {
    const { measureBenchmark } = await import("../src/benchmark/engine");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await measureBenchmark({
      ...base,
      apiUrl: "http://169.254.169.254/latest/meta-data",
      apiKey: undefined,
      benchmark: {
        type: "short",
        prompt: "hi",
        max_tokens: 8,
        timeout_ms: 100,
      },
    } as never);
    expect(res.status).toBe("UNKNOWN_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
