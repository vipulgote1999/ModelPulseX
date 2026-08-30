import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Env,
  LLMProvider,
  ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";

const CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
// Gemini OpenAI-compat models list — same base: /v1beta/openai/models (Bearer)
const MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/models";

const FALLBACK = [
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", ctx: 1048576 },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", ctx: 1048576 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", ctx: 1048576 },
  { id: "gemma-3-27b-it", name: "Gemma 3 27B", ctx: 131072 },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", ctx: 1048576 },
];

export class GeminiProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() {
    return "gemini" as const;
  }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      assertSafeApiUrl(MODELS_URL);

      const res = await fetch(MODELS_URL, {
        headers: this.env.GEMINI_API_KEY
          ? { authorization: `Bearer ${this.env.GEMINI_API_KEY}` }
          : ({} as Record<string, string>),
      });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
      // filter to known free-tier gemini models only
      const free = ids.filter((id) => /gemini|gemma/i.test(id));
      if (free.length === 0) return this.fallback();
      return free.slice(0, 12).map((id) => ({
        provider: "gemini" as const,
        provider_model_id: id,
        display_name: id,
        context_length: id.includes("gemma") ? 131072 : 1048576,
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
      provider: "gemini" as const,
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
  async benchmarkModel(
    model: { provider_model_id: string },
    benchmark: BenchmarkDefinition,
  ): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: "gemini",
      providerModelId: model.provider_model_id,
      apiUrl: CHAT_URL,
      apiKey: this.env.GEMINI_API_KEY,
      benchmark,
    });
  }
}
