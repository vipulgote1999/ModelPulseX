import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";

const CHAT_URL = "https://api.sambanova.ai/v1/chat/completions";
const MODELS_URL = "https://api.sambanova.ai/v1/models";

const FALLBACK = [
  { id: "Meta-Llama-3.3-70B-Instruct", name: "Meta Llama 3.3 70B", ctx: 131072 },
];

export class SambanovaProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() { return "sambanova" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      const res = await fetch(MODELS_URL, { headers: (this.env.SAMBANOVA_API_KEY ? { authorization: `Bearer ${this.env.SAMBANOVA_API_KEY}` } : {} as Record<string,string>) });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data ?? []).map(m => m.id).filter(Boolean);
      if (ids.length === 0) return this.fallback();
      return ids.slice(0, 8).map(id => ({
        provider: "sambanova" as const,
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
      provider: "sambanova" as const,
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
      provider: "sambanova",
      providerModelId: model.provider_model_id,
      apiUrl: CHAT_URL,
      apiKey: this.env.SAMBANOVA_API_KEY,
      benchmark,
    });
  }
}
