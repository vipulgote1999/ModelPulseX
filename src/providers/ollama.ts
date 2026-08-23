import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";

const MODELS_URL = "https://ollama.com/v1/models";
const CHAT_URL = "https://ollama.com/v1/chat/completions";

// Verified free Ollama Cloud models with key 7cb2e... — others require subscription (tested 2026-08-23)
const FREE_OLLAMA_IDS = new Set<string>([
  "gemma4:31b",
  "minimax-m3",
  "gpt-oss:20b",
  "gpt-oss:120b",
  "nemotron-3-super",
  "nemotron-3-ultra",
  "nemotron-3-nano:30b",
]);

const FALLBACK = [
  { id: "gemma4:31b", name: "Gemma 4 31B (Ollama Cloud)", ctx: 131072 },
  { id: "minimax-m3", name: "MiniMax M3 (Ollama Cloud)", ctx: 128000 },
  { id: "gpt-oss:20b", name: "GPT OSS 20B (Ollama Cloud)", ctx: 131072 },
  { id: "gpt-oss:120b", name: "GPT OSS 120B (Ollama Cloud)", ctx: 131072 },
  { id: "nemotron-3-super", name: "Nemotron 3 Super (Ollama Cloud)", ctx: 128000 },
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra (Ollama Cloud)", ctx: 128000 },
  { id: "nemotron-3-nano:30b", name: "Nemotron 3 Nano 30B (Ollama Cloud)", ctx: 128000 },
];

export class OllamaProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() {
    return "ollama" as const;
  }

  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      const res = await fetch(MODELS_URL, {
        headers: this.env.OLLAMA_API_KEY ? { authorization: `Bearer ${this.env.OLLAMA_API_KEY}` } : {},
      });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ name: string }> };
      const idsRaw = (data.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      const idsTags = ((data as unknown as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name).filter(Boolean);
      const ids = idsRaw.length ? idsRaw : idsTags;
      if (ids.length === 0) return this.fallback();
      // Only benchmark verified free models — paid/subscription models would always return PROVIDER_ERROR and waste quota
      const freeIds = ids.filter((id) => FREE_OLLAMA_IDS.has(id));
      if (freeIds.length === 0) return this.fallback();
      return freeIds.slice(0, 20).map((id) => ({
        provider: "ollama" as const,
        provider_model_id: id,
        display_name: id,
        context_length: 128000,
        capabilities: ["text"],
        input_price: "0",
        output_price: "0",
        is_free: true,
        free_status: "FREE" as const,
      }));
    } catch {
      return this.fallback();
    }
  }

  private fallback(): ModelMetadata[] {
    return FALLBACK.map((m) => ({
      provider: "ollama" as const,
      provider_model_id: m.id,
      display_name: m.name,
      context_length: m.ctx,
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
      provider: "ollama",
      providerModelId: model.provider_model_id,
      apiUrl: CHAT_URL,
      apiKey: this.env.OLLAMA_API_KEY,
      benchmark,
    });
  }
}
