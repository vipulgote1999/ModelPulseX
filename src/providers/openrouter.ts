import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";

const OR_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OR_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

interface ORModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  architecture: { modality: string };
}

export class OpenRouterProvider implements LLMProvider {
  constructor(private env: Env) {}

  getProviderName() {
    return "openrouter" as const;
  }

  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      const res = await fetch(OR_MODELS_URL, {
        headers: this.env.OPENROUTER_API_KEY ? { authorization: `Bearer ${this.env.OPENROUTER_API_KEY}` } : {},
      });
      if (!res.ok) {
        console.warn("openrouter discover", res.status);
        return this.fallbackFree();
      }
      const data = (await res.json()) as { data: ORModel[] };
      const free = (data.data ?? []).filter((m) => {
        const p = parseFloat(m.pricing?.prompt ?? "1");
        const c = parseFloat(m.pricing?.completion ?? "1");
        return p === 0 && c === 0;
      });
      if (free.length === 0) return this.fallbackFree();
      return free
        .filter((m) => {
          // exclude audio-only Lyria which is not chat benchmarkable; keep but mark non-text
          if (m.architecture?.modality?.includes("->text+audio") || m.architecture?.modality?.includes("->audio")) {
            // still free but not useful for chat benchmark — skip for now
            return false;
          }
          return true;
        })
        .map((m) => ({
          provider: "openrouter" as const,
          provider_model_id: m.id,
          display_name: m.name,
          context_length: m.context_length,
          capabilities: this.capTo(m.architecture?.modality),
          input_price: m.pricing.prompt,
          output_price: m.pricing.completion,
          is_free: true,
          free_status: "FREE" as const,
        }));
    } catch (e) {
      console.warn("or discover error", e);
      return this.fallbackFree();
    }
  }

  private capTo(modality: string | undefined): string[] {
    if (!modality) return ["text"];
    const caps: string[] = [];
    if (modality.includes("text")) caps.push("text");
    if (modality.includes("image")) caps.push("vision");
    if (modality.includes("audio")) caps.push("audio");
    if (caps.length === 0) caps.push("text");
    return caps;
  }

  private fallbackFree(): ModelMetadata[] {
    // last-known 2026-08-23 snapshot minus audio-only
    const ids: Array<{ id: string; name: string; ctx: number }> = [
      { id: "dots-studio/dots-3-note-preview:free", name: "Dots Studio: Dots3-Note Preview (free)", ctx: 512000 },
      { id: "liquid/lfm-2.5-2.6b:free", name: "LiquidAI: LFM2.5-2.6B (free)", ctx: 65536 },
      { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA: Nemotron 3.5 Lightning (free)", ctx: 1_000_000 },
      { id: "thinkingmachines/inkling-small:free", name: "Thinking Machines: Inkling Small (free)", ctx: 262144 },
      { id: "poolside/laguna-s-2.1:free", name: "Poolside: Laguna S 2.1 (free)", ctx: 262144 },
      { id: "thinkingmachines/inkling:free", name: "Thinking Machines: Inkling (free)", ctx: 262144 },
      { id: "poolside/laguna-xs-2.1:free", name: "Poolside: Laguna XS 2.1 (free)", ctx: 262144 },
      { id: "cohere/north-mini-code:free", name: "Cohere: North Mini Code (free)", ctx: 256000 },
      { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2 (free)", ctx: 256000 },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "NVIDIA: Nemotron 3 Ultra (free)", ctx: 1_000_000 },
      { id: "google/gemma-4-26b-a4b-it:free", name: "Google: Gemma 4 26B A4B (free)", ctx: 262144 },
      { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)", ctx: 262144 },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA: Nemotron 3 Super (free)", ctx: 262144 },
      { id: "openrouter/free", name: "Free Models Router", ctx: 200000 },
      { id: "nvidia/nemotron-3-nano-30b-a3b:free", name: "NVIDIA: Nemotron 3 Nano 30B A3B (free)", ctx: 256000 },
      { id: "nvidia/nemotron-nano-12b-v2-vl:free", name: "NVIDIA: Nemotron Nano 12B 2 VL (free)", ctx: 128000 },
      { id: "nvidia/nemotron-nano-9b-v2:free", name: "NVIDIA: Nemotron Nano 9B V2 (free)", ctx: 128000 },
      { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "NVIDIA: Nemotron 3 Nano Omni (free)", ctx: 256000 },
      { id: "nvidia/nemotron-3.5-content-safety:free", name: "NVIDIA: Nemotron 3.5 Content Safety", ctx: 128000 },
    ];
    return ids.map(({ id, name, ctx }) => ({
      provider: "openrouter" as const,
      provider_model_id: id,
      display_name: name,
      context_length: ctx,
      capabilities: ["text"],
      input_price: "0",
      output_price: "0",
      is_free: true,
      free_status: "FREE" as const,
    }));
  }

  async getModelMetadata(modelId: string): Promise<ModelMetadata | null> {
    const all = await this.discoverModels();
    return all.find((m) => m.provider_model_id === modelId) ?? null;
  }

  async benchmarkModel(model: { provider_model_id: string }, benchmark: BenchmarkDefinition): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: "openrouter",
      providerModelId: model.provider_model_id,
      apiUrl: OR_CHAT_URL,
      apiKey: this.env.OPENROUTER_API_KEY,
      benchmark,
    });
  }
}
