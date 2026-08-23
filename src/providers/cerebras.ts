import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";

const MODELS_URL = "https://api.cerebras.ai/v1/models";
const CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";

const FALLBACK = [
  { id: "gpt-oss-120b", name: "GPT OSS 120B", ctx: 131072 },
  { id: "llama-3.3-70b", name: "Llama 3.3 70B", ctx: 131072 },
  { id: "qwen-3-32b", name: "Qwen3 32B", ctx: 131072 },
];

export class CerebrasProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() { return "cerebras" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      const res = await fetch(MODELS_URL, { headers: (this.env.CEREBRAS_API_KEY ? { authorization: `Bearer ${this.env.CEREBRAS_API_KEY}` } : {} as Record<string,string>) });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data ?? []).map(m => m.id).filter(Boolean);
      if (ids.length === 0) return this.fallback();
      return ids.map(id => ({
        provider: "cerebras" as const,
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
      provider: "cerebras" as const,
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
    return all.find(m => m.provider_model_id === modelId) ?? null;
  }
  async benchmarkModel(model: { provider_model_id: string }, benchmark: BenchmarkDefinition): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: "cerebras",
      providerModelId: model.provider_model_id,
      apiUrl: CHAT_URL,
      apiKey: this.env.CEREBRAS_API_KEY,
      benchmark,
    });
  }
}
