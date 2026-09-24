import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  validatePlaygroundInput,
  truncatePreview,
} from "../src/utils/playground";
import { playgroundRoutes } from "../src/api/admin/playground";

const TOKEN = "test-admin-token-0123456789abcdef";

function postTest(body: unknown, token: string | null = TOKEN) {
  const app = playgroundRoutes({ ADMIN_TOKEN: TOKEN } as never);
  return app.request("/admin/playground/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("playground validation (pure)", () => {
  const base = {
    provider: "openrouter",
    provider_model_id: "test:free",
    prompt: "Say OK",
  };
  it("accepts minimal valid input with defaults", () => {
    const r = validatePlaygroundInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.benchmark.max_tokens).toBe(256);
      expect(r.value.benchmark.timeout_ms).toBe(60000);
      expect(r.value.benchmark.type).toBe("coding");
    }
  });
  it("rejects unknown provider", () => {
    const r = validatePlaygroundInput({ ...base, provider: "evil" });
    expect(r.ok).toBe(false);
  });
  it("rejects empty/long prompt", () => {
    expect(validatePlaygroundInput({ ...base, prompt: "  " }).ok).toBe(false);
    expect(
      validatePlaygroundInput({ ...base, prompt: "x".repeat(4001) }).ok,
    ).toBe(false);
  });
  it("rejects out-of-range sampling params", () => {
    expect(
      validatePlaygroundInput({ ...base, temperature: 5 }).ok,
    ).toBe(false);
    expect(validatePlaygroundInput({ ...base, top_p: 2 }).ok).toBe(false);
    expect(validatePlaygroundInput({ ...base, max_tokens: 2 }).ok).toBe(false);
    expect(
      validatePlaygroundInput({ ...base, max_tokens: 4092 }).ok,
    ).toBe(false);
    expect(validatePlaygroundInput({ ...base, timeout_ms: 100 }).ok).toBe(
      false,
    );
    expect(validatePlaygroundInput({ ...base, timeout_ms: 300000 }).ok).toBe(
      false,
    );
  });
  it("accepts temperature/system/top_p in range", () => {
    const r = validatePlaygroundInput({
      ...base,
      temperature: 0.7,
      top_p: 0.9,
      system: "Be concise.",
      max_tokens: 128,
      timeout_ms: 30000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.benchmark.temperature).toBe(0.7);
      expect(r.value.benchmark.top_p).toBe(0.9);
      expect(r.value.benchmark.system_prompt).toBe("Be concise.");
    }
  });
  it("truncatePreview caps at 2000 chars", () => {
    expect(truncatePreview("x".repeat(5000)).length).toBe(2000);
    expect(truncatePreview("hi")).toBe("hi");
  });
});

describe("playground engine chat params", () => {
  it("sends temperature + system message in request body", async () => {
    const { measureBenchmark } = await import("../src/benchmark/engine");
    const enc = new TextEncoder();
    let seenBody: Record<string, unknown> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        seenBody = JSON.parse(
          (init as { body: string }).body,
        ) as Record<string, unknown>;
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const res = await measureBenchmark({
      provider: "openrouter",
      providerModelId: "test:free",
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: undefined,
      benchmark: {
        type: "coding",
        prompt: "Say OK",
        max_tokens: 64,
        timeout_ms: 5000,
        temperature: 0.5,
        system_prompt: "Be concise.",
      },
      includePreview: true,
    });
    expect(res.status).toBe("SUCCESS");
    expect(res.preview).toBe("hi");
    const msgs = seenBody!["messages"] as Array<{ role: string }>;
    expect(msgs[0]!.role).toBe("system");
    expect(seenBody!["temperature"]).toBe(0.5);
    vi.restoreAllMocks();
  });
});

describe("playground route guards", () => {
  it("rejects unauthenticated", async () => {
    const res = await postTest(
      { provider: "openrouter", provider_model_id: "m", prompt: "hi" },
      null,
    );
    expect(res.status).toBe(401);
  });
  it("rejects client-supplied urls/keys (registry-only)", async () => {
    const res = await postTest({
      provider: "openrouter",
      provider_model_id: "m",
      prompt: "hi",
      apiUrl: "https://evil.example.com/v1",
    });
    expect(res.status).toBe(400);
    const res2 = await postTest({
      provider: "openrouter",
      provider_model_id: "m",
      prompt: "hi",
      apiKey: "sk-evil",
    });
    expect(res2.status).toBe(400);
  });
  it("rejects unknown provider before any fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await postTest({
      provider: "nope",
      provider_model_id: "m",
      prompt: "hi",
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("frontend CODING_DEFAULT mirrors WORKLOADS.coding.prompt", async () => {
    const { WORKLOADS } = await import("../src/benchmark/workloads");
    const ui = readFileSync("frontend/src/pages/admin/presets.ts", "utf8");
    expect(ui).toContain(WORKLOADS.coding.prompt);
  });
  it("never touches queue/DO/runs tables (ephemeral by construction)", () => {
    const src = readFileSync("src/api/admin/playground.ts", "utf8");
    expect(src).not.toContain("BENCH_QUEUE");
    expect(src).not.toContain("LIVE_DO");
    expect(src).not.toContain("insertBenchmarkRun");
    expect(src).not.toContain("benchmark_runs");
    expect(src).toContain("includePreview");
    expect(src).toContain("getProviderEndpoint");
  });
});
