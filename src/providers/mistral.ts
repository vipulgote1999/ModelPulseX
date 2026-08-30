import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Env,
  LLMProvider,
  ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";

const MODELS_URL = "https://api.mistral.ai/v1/models";
const CHAT_URL = "https://api.mistral.ai/v1/chat/completions";

const FALLBACK = [
  { id: "mistral-small-latest", name: "Mistral Small", ctx: 131072 },
  { id: "codestral-latest", name: "Codestral", ctx: 262144 },
  { id: "ministral-8b-latest", name: "Ministral 8B", ctx: 131072 },
  { id: "mistral-medium-latest", name: "Mistral Medium", ctx: 131072 },
  { id: "magistral-small-latest", name: "Magistral Small", ctx: 131072 },
];

export class MistralProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() {
    return "mistral" as const;
  }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      assertSafeApiUrl(MODELS_URL);

      const res = await fetch(MODELS_URL, {
        headers: this.env.MISTRAL_API_KEY
          ? { authorization: `Bearer ${this.env.MISTRAL_API_KEY}` }
          : ({} as Record<string, string>),
      });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
      if (ids.length === 0) return this.fallback();
      return ids.slice(0, 10).map((id) => ({
        provider: "mistral" as const,
        provider_model_id: id,
        display_name: id,
        context_length: 131072,
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
      provider: "mistral" as const,
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
    return all.find((m) => m.provider_model_id === id) ?? null;
  }
  async benchmarkModel(
    model: { provider_model_id: string },
    benchmark: BenchmarkDefinition,
  ): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: "mistral",
      providerModelId: model.provider_model_id,
      apiUrl: CHAT_URL,
      apiKey: this.env.MISTRAL_API_KEY,
      benchmark,
    });
  }
}
