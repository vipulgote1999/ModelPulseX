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
    // reasoning headroom: 2048 is the ceiling (512 starved thinkers into reasoning_no_content)
    expect(validatePlaygroundInput({ ...base, max_tokens: 2048 }).ok).toBe(true);
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
  it("accepts a session-only apiKey override, rejects oversized keys", () => {
    const r = validatePlaygroundInput({ ...base, apiKey: "sk-session-123" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.apiKey).toBe("sk-session-123");
    expect(
      validatePlaygroundInput({ ...base, apiKey: "x".repeat(501) }).ok,
    ).toBe(false);
    expect(validatePlaygroundInput({ ...base, apiKey: 123 }).ok).toBe(false);
    // absent key stays undefined — server env key is used
    const d = validatePlaygroundInput(base);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value.apiKey).toBeUndefined();
  });
  it("accepts a session-only chatUrl override, rejects bad shapes", () => {
    const r = validatePlaygroundInput({
      ...base,
      chatUrl: "https://custom.example.com/v1/chat/completions",
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.chatUrl).toBe(
        "https://custom.example.com/v1/chat/completions",
      );
    expect(
      validatePlaygroundInput({ ...base, chatUrl: "x".repeat(501) }).ok,
    ).toBe(false);
    expect(validatePlaygroundInput({ ...base, chatUrl: 123 }).ok).toBe(false);
    expect(validatePlaygroundInput({ ...base, chatUrl: "x" }).ok).toBe(false);
    const d = validatePlaygroundInput(base);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value.chatUrl).toBeUndefined();
  });
  it("truncatePreview caps at 2000 chars", () => {
    expect(truncatePreview("x".repeat(5000)).length).toBe(2000);
    expect(truncatePreview("hi")).toBe("hi");
  });
});

describe("debug header redaction (pure)", () => {
  it("redacts secret-bearing headers, keeps the rest", async () => {
    const { redactHeaders } = await import("../src/utils/security");
    const out = redactHeaders({
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: "Bearer sk-secret-123",
      "x-opencode-session": "ses_abc",
      "HTTP-Referer": "https://example.test",
    });
    expect(out["content-type"]).toBe("application/json");
    expect(out["HTTP-Referer"]).toBe("https://example.test");
    expect(out.authorization).toBe("REDACTED");
    expect(out["x-opencode-session"]).toBe("REDACTED");
    expect(JSON.stringify(out)).not.toContain("sk-secret-123");
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

describe("playground route guards", () => {  it("rejects unauthenticated", async () => {
    const res = await postTest(
      { provider: "openrouter", provider_model_id: "m", prompt: "hi" },
      null,
    );
    expect(res.status).toBe(401);
  });
  it("rejects client-supplied urls/headers (registry-only)", async () => {
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
      headers: { authorization: "Bearer sk-evil" },
    });
    expect(res2.status).toBe(400);
  });
  it("lets a session apiKey pass the registry guard (used for one request only)", async () => {
    // unknown provider fails later at provider lookup — not at the url/key guard
    const res = await postTest({
      provider: "nope",
      provider_model_id: "m",
      prompt: "hi",
      apiKey: "sk-session-123",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error?: string };
    expect(j.error ?? "").toContain("unknown provider");
  });
  it("uses a custom chatUrl for the request and flags it", async () => {
    const { playgroundRoutes } = await import("../src/api/admin/playground");
    const enc = new TextEncoder();
    const mkStream = () =>
      new ReadableStream({
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
    let seenUrl: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        seenUrl = String(url);
        return new Response(mkStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const app = playgroundRoutes({ ADMIN_TOKEN: TOKEN } as never);
    const res = await app.request("/admin/playground/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        provider: "openrouter",
        provider_model_id: "test:free",
        prompt: "Say OK",
        chatUrl: "https://custom.example.com/v1/chat/completions",
      }),
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://custom.example.com/v1/chat/completions");
    const j = (await res.json()) as {
      resolvedChatUrl?: string;
      custom_url_used?: boolean;
    };
    expect(j.resolvedChatUrl).toBe(
      "https://custom.example.com/v1/chat/completions",
    );
    expect(j.custom_url_used).toBe(true);
    vi.restoreAllMocks();
  });
  it("rejects a blocked custom chatUrl with 400 before any fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await postTest({
      provider: "openrouter",
      provider_model_id: "m",
      prompt: "hi",
      chatUrl: "http://169.254.169.254/latest/meta-data",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error?: string };
    expect(j.error ?? "").toContain("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
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
    expect(src).toContain("includeDebug");
    expect(src).toContain("getProviderEndpoint");
  });
});

describe("playground debug bundle", () => {
  it("engine attaches redacted request + SSE transcript when includeDebug", async () => {
    const { measureBenchmark } = await import("../src/benchmark/engine");
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const push = (obj: unknown) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        push({ choices: [{ delta: { reasoning_content: "thinking" } }] });
        push({ choices: [{ delta: { content: "hi" } }] });
        push({ usage: { prompt_tokens: 5, completion_tokens: 9 } });
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
      apiKey: "sk-secret-xyz",
      benchmark: {
        type: "coding",
        prompt: "Say OK",
        max_tokens: 64,
        timeout_ms: 5000,
      },
      includeDebug: true,
    });
    expect(res.status).toBe("SUCCESS");
    expect(res.debug).toBeDefined();
    expect(res.debug!.request.method).toBe("POST");
    expect(res.debug!.request.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(res.debug!.request.headers.authorization).toBe("REDACTED");
    expect(res.debug!.response.http_status).toBe(200);
    expect(res.debug!.response.sse_lines).toBe(3);
    expect(res.debug!.response.sse_preview.length).toBe(3);
    expect(res.debug!.response.reasoning_seen).toBe(true);
    expect(res.debug!.reproduce_hint).toContain("curl");
    expect(JSON.stringify(res.debug)).not.toContain("sk-secret-xyz");
    vi.restoreAllMocks();
  });

  it("engine omits debug unless requested (zero cron overhead)", async () => {
    const { measureBenchmark } = await import("../src/benchmark/engine");
    const enc = new TextEncoder();
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
        type: "coding",
        prompt: "Say OK",
        max_tokens: 64,
        timeout_ms: 5000,
      },
    });
    expect(res.status).toBe("SUCCESS");
    expect(res.debug).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("route returns debug with no secret leakage", async () => {
    const { playgroundRoutes } = await import("../src/api/admin/playground");
    const enc = new TextEncoder();
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
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const app = playgroundRoutes({
      ADMIN_TOKEN: TOKEN,
      OPENROUTER_API_KEY: "sk-route-secret-999",
    } as never);
    const res = await app.request("/admin/playground/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        provider: "openrouter",
        provider_model_id: "test:free",
        prompt: "Say OK",
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-route-secret-999");
    const j = JSON.parse(text) as {
      debug?: { request?: { headers?: Record<string, string> } };
    };
    expect(j.debug).toBeDefined();
    expect(j.debug!.request!.headers!.authorization).toBe("REDACTED");
    vi.restoreAllMocks();
  });

  it("session apiKey override is used for the request and never echoed", async () => {
    const { playgroundRoutes } = await import("../src/api/admin/playground");
    const enc = new TextEncoder();
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
    let seenAuth: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        const headers = (init as { headers: Record<string, string> }).headers;
        seenAuth =
          headers["authorization"] ?? headers["Authorization"] ?? null;
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const app = playgroundRoutes({ ADMIN_TOKEN: TOKEN } as never);
    const res = await app.request("/admin/playground/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        provider: "openrouter",
        provider_model_id: "test:free",
        prompt: "Say OK",
        apiKey: "sk-session-secret-456",
      }),
    });
    expect(res.status).toBe(200);
    expect(seenAuth).toBe("Bearer sk-session-secret-456");
    const text = await res.text();
    expect(text).not.toContain("sk-session-secret-456");
    vi.restoreAllMocks();
  });
});
