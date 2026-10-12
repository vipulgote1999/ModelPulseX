import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Env,
  LLMProvider,
  ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";

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
  {
    id: "nemotron-3-super",
    name: "Nemotron 3 Super (Ollama Cloud)",
    ctx: 128000,
  },
  {
    id: "nemotron-3-ultra",
    name: "Nemotron 3 Ultra (Ollama Cloud)",
    ctx: 128000,
  },
  {
    id: "nemotron-3-nano:30b",
    name: "Nemotron 3 Nano 30B (Ollama Cloud)",
    ctx: 128000,
  },
];

export type OllamaTier = "free" | "pro";

export class OllamaProvider implements LLMProvider {
  constructor(
    private env: Env,
    private tier: OllamaTier = "free",
  ) {}
  getProviderName() {
    return this.tier === "pro" ? ("ollama_pro" as const) : ("ollama" as const);
  }

  private apiKey(): string | undefined {
    // Pro tier prefers its own key and falls back to the shared Ollama key;
    // paid models without any usable key simply fail closed via cooldowns.
    return this.tier === "pro"
      ? (this.env.OLLAMA_PRO_API_KEY ?? this.env.OLLAMA_API_KEY)
      : this.env.OLLAMA_API_KEY;
  }

  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      assertSafeApiUrl(MODELS_URL);

      const apiKey = this.apiKey();
      const res = await fetch(MODELS_URL, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) return this.tier === "pro" ? [] : this.fallback();
      const data = (await res.json()) as {
        data?: Array<{ id: string }>;
        models?: Array<{ name: string }>;
      };
      const idsRaw = (data.data ?? [])
        .map((m) => m.id)
        .filter(Boolean) as string[];
      // SAFETY: Ollama API may return {data:[{id}]} or {models:[{name}]}; widen to handle both shapes safely
      const idsTags = (
        (data as unknown as { models?: Array<{ name: string }> }).models ?? []
      )
        .map((m) => m.name)
        .filter(Boolean);
      const ids = idsRaw.length ? idsRaw : idsTags;
      if (this.tier === "pro") return this.proCatalog(ids);
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
      return this.tier === "pro" ? [] : this.fallback();
    }
  }

  // Pro tier: full catalog. Allowlist ids are FREE; everything else on the
  // public instance requires a subscription (tested 2026-08-23), so it is
  // marked PAID — stored for cross-tier comparison, never auto-queued
  // (verifyFree gate + default-disabled provider).
  private proCatalog(ids: string[]): ModelMetadata[] {
    return ids.slice(0, 50).map((id) => {
      const free = FREE_OLLAMA_IDS.has(id);
      return {
        provider: "ollama_pro" as const,
        provider_model_id: id,
        display_name: id,
        context_length: 128000,
        capabilities: ["text"],
        input_price: free ? "0" : null,
        output_price: free ? "0" : null,
        is_free: free,
        free_status: free ? ("FREE" as const) : ("PAID" as const),
      };
    });
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

  async benchmarkModel(
    model: { provider_model_id: string },
    benchmark: BenchmarkDefinition,
  ): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: this.getProviderName(),
      providerModelId: model.provider_model_id,
      apiUrl: CHAT_URL,
      apiKey: this.apiKey(),
      benchmark,
    });
  }
}
