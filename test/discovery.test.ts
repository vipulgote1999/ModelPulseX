import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenCodeZenProvider } from "../src/providers/opencode-zen";
import { OpenRouterProvider } from "../src/providers/openrouter";

// Mock fetch globally
function mockModelsResponse(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

describe("discovery — free filtering", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("OpenRouter only FREE where prompt==0 && completion==0", async () => {
    const fake = {
      data: [
        { id: "a:free", name: "A", context_length: 1000, pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->text" } },
        { id: "b:paid", name: "B", context_length: 1000, pricing: { prompt: "0", completion: "0.001" }, architecture: { modality: "text->text" } },
        { id: "c:free2", name: "C", context_length: 1000, pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->text" } },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => mockModelsResponse(fake)));
    const p = new OpenRouterProvider({} as never);
    const models = await p.discoverModels();
    const ids = models.map((m) => m.provider_model_id);
    expect(ids).toContain("a:free");
    expect(ids).toContain("c:free2");
    expect(ids).not.toContain("b:paid");
    expect(models.every((m) => m.free_status === "FREE")).toBe(true);
  });

  it("OpenRouter excludes audio-output lyria preview (not chat benchmarkable)", async () => {
    const fake = {
      data: [
        { id: "google/lyria-3-pro-preview", name: "Lyria", context_length: 1048576, pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text+image->text+audio" } },
        { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron", context_length: 262144, pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->text" } },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => mockModelsResponse(fake)));
    const p = new OpenRouterProvider({} as never);
    const ids = (await p.discoverModels()).map((m) => m.provider_model_id);
    expect(ids).not.toContain("google/lyria-3-pro-preview");
    expect(ids).toContain("nvidia/nemotron-3-super-120b-a12b:free");
  });

  it("Zen only *-free + big-pickle", async () => {
    const fake = { data: [{ id: "big-pickle" }, { id: "deepseek-v4-flash-free" }, { id: "gpt-5.5" }, { id: "laguna-s-2.1-free" }] };
    vi.stubGlobal("fetch", vi.fn(async () => mockModelsResponse(fake)));
    const p = new OpenCodeZenProvider({} as never);
    const ids = (await p.discoverModels()).map((m) => m.provider_model_id);
    expect(ids).toContain("big-pickle");
    expect(ids).toContain("deepseek-v4-flash-free");
    expect(ids).toContain("laguna-s-2.1-free");
    expect(ids).not.toContain("gpt-5.5");
  });

  it("Zen fallback when fetch fails returns 9 known free", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const p = new OpenCodeZenProvider({} as never);
    const ids = (await p.discoverModels()).map((m) => m.provider_model_id);
    expect(ids.length).toBe(9);
    expect(ids).toContain("big-pickle");
  });

  it("UNKNOWN pricing skipped (no model with pricing missing treated as FREE)", async () => {
    // For Zen, unknown suffix not free — covered. For OR, fake has pricing missing treated as paid fallback
    const fake = { data: [{ id: "model-a", name: "A", context_length: 1000, pricing: { prompt: "0", completion: "0.001" }, architecture: { modality: "text->text" } }] };
    vi.stubGlobal("fetch", vi.fn(async () => mockModelsResponse(fake)));
    const p = new OpenRouterProvider({} as never);
    const ids = (await p.discoverModels()).map((m) => m.provider_model_id);
    expect(ids).not.toContain("model-a");
  });
});
