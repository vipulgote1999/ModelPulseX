import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Env,
  LLMProvider,
  ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

interface GroqModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

// Verified FREE per GroqCloud + freellm.net 2026-05-13: only these are $0 on free tier (others are paid now: llama-3.1-8b-instant etc. marked No Longer Free)
// Keep audio whisper ids in allowlist but they are NOT chat-benchmarkable — flagged disabled separately via migration.
const VERIFIED_FREE = new Set<string>([
  "qwen/qwen3.6-27b",
  "minimaxai/minimax-m2.7",
  "groq/compound",
  "groq/compound-mini",
  "moonshotai/kimi-k2-instruct",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-safeguard-20b",
  "whisper-large-v3",
  "whisper-large-v3-turbo",
]);

const FALLBACK_VERIFIED: Array<{ id: string; name: string; ctx: number }> = [
  { id: "openai/gpt-oss-120b", name: "GPT OSS 120B (Groq Free)", ctx: 131072 },
  { id: "openai/gpt-oss-20b", name: "GPT OSS 20B (Groq Free)", ctx: 131072 },
  { id: "qwen/qwen3.6-27b", name: "Qwen3.6 27B (Groq Free)", ctx: 131072 },
  {
    id: "minimaxai/minimax-m2.7",
    name: "MiniMax M2.7 (Groq Free)",
    ctx: 196608,
  },
  {
    id: "moonshotai/kimi-k2-instruct",
    name: "Kimi K2 (Groq Free)",
    ctx: 131072,
  },
  { id: "groq/compound", name: "Groq Compound (Free)", ctx: 131072 },
  { id: "groq/compound-mini", name: "Groq Compound Mini (Free)", ctx: 131072 },
];

function toMeta(id: string): ModelMetadata {
  const isFree = VERIFIED_FREE.has(id);
  return {
    provider: "groq" as const,
    provider_model_id: id,
    display_name: id,
    context_length: 131072,
    capabilities: ["text"],
    input_price: isFree ? "0" : "0.00015",
    output_price: isFree ? "0" : "0.0006",
    is_free: isFree,
    free_status: isFree ? ("FREE" as const) : ("PAID" as const),
  };
}

export class GroqProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() {
    return "groq" as const;
  }

  async discoverModels(): Promise<ModelMetadata[]> {
    try {

      assertSafeApiUrl(GROQ_MODELS_URL);

      const res = await fetch(GROQ_MODELS_URL, {
        headers: this.env.GROQ_API_KEY
          ? { authorization: `Bearer ${this.env.GROQ_API_KEY}` }
          : ({} as Record<string, string>),
      });
      if (!res.ok) return this.fallback();
      const data = (await res.json()) as { data?: GroqModel[] };
      const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
      if (ids.length === 0) return this.fallback();
      // Return ALL ids with correct free_status so admin can see disabled paid ones and enable if they go free again
      return ids.map(toMeta);
    } catch {
      return this.fallback();
    }
  }

  private fallback(): ModelMetadata[] {
    return FALLBACK_VERIFIED.map((m) => ({
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
    return all.find((m) => m.provider_model_id === modelId) ?? null;
  }

  async benchmarkModel(
    model: { provider_model_id: string },
    benchmark: BenchmarkDefinition,
  ): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: "groq",
      providerModelId: model.provider_model_id,
      apiUrl: GROQ_CHAT_URL,
      apiKey: this.env.GROQ_API_KEY,
      benchmark,
    });
  }
}
