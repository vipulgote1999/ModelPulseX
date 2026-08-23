import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";

const MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const FALLBACK = [
  { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct", ctx: 131072 },
  { id: "meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B", ctx: 131072 },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", name: "Nemotron 70B", ctx: 131072 },
  { id: "google/gemma-2-27b-it", name: "Gemma 2 27B", ctx: 8192 },
  { id: "mistralai/mistral-7b-instruct-v0.3", name: "Mistral 7B", ctx: 32768 },
];

export class NvidiaProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() { return "nvidia" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    if (!this.env.NVIDIA_API_KEY) return [];
    try {
      const res = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${this.env.NVIDIA_API_KEY}` } });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data ?? []).map(m => m.id).filter(Boolean);
      if (ids.length === 0) return this.fallback();
      return ids.slice(0, 15).map(id => ({
        provider: "nvidia" as const,
        provider_model_id: id,
        display_name: id,
        context_length: 131072,
        capabilities: ["text"],
        input_price: "0",
        output_price: "0",
        is_free: true,
        free_status: "FREE" as const,
      }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[] {
    return FALLBACK.map(m => ({
      provider: "nvidia" as const,
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
  async getModelMetadata(id: string): Promise<ModelMetadata | null> {
    const all = await this.discoverModels();
    return all.find(m => m.provider_model_id === id) ?? null;
  }
  async benchmarkModel(model: { provider_model_id: string }, benchmark: BenchmarkDefinition): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: "nvidia",
      providerModelId: model.provider_model_id,
      apiUrl: CHAT_URL,
      apiKey: this.env.NVIDIA_API_KEY,
      benchmark,
    });
  }
}
