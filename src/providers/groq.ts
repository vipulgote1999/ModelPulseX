import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

interface GroqModel { id: string; object?: string; created?: number; owned_by?: string; }

const FALLBACK = [
  { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", ctx: 131072 },
  { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", ctx: 131072 },
  { id: "openai/gpt-oss-20b", name: "GPT OSS 20B", ctx: 131072 },
  { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", ctx: 131072 },
  { id: "qwen/qwen3-32b", name: "Qwen3 32B", ctx: 131072 },
  { id: "allam-2-7b", name: "ALLaM 2 7B", ctx: 131072 },
  { id: "groq/compound", name: "Groq Compound", ctx: 131072 },
  { id: "groq/compound-mini", name: "Groq Compound Mini", ctx: 131072 },
];

export class GroqProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() { return "groq" as const; }

  async discoverModels(): Promise<ModelMetadata[]> {
    if (!this.env.GROQ_API_KEY) return [];
    try {
      const res = await fetch(GROQ_MODELS_URL, { headers: { authorization: `Bearer ${this.env.GROQ_API_KEY}` } });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: GroqModel[] };
      const ids = (data.data ?? []).map(m => m.id).filter(Boolean);
      if (ids.length === 0) return this.fallback();
      return ids.map(id => ({
        provider: "groq" as const,
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
      provider: "groq" as const,
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
      provider: "groq",
      providerModelId: model.provider_model_id,
      apiUrl: GROQ_CHAT_URL,
      apiKey: this.env.GROQ_API_KEY,
      benchmark,
    });
  }
}
