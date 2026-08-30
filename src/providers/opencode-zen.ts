import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";

const KNOWN_FREE_EXACT = new Set<string>(["big-pickle"]);

function isFreeZenModel(id: string): boolean {
  if (KNOWN_FREE_EXACT.has(id)) return true;
  return id.endsWith("-free");
}

function contextFor(id: string): number {
  const lower = id.toLowerCase();
  if (lower.includes("nemotron")) return 1_000_000;
  if (lower.includes("laguna")) return 262_144;
  return 131_072;
}

function capabilitiesFor(id: string): string[] {
  const lower = id.toLowerCase();
  if (lower.includes("vision") || lower.includes("vl")) return ["vision"];
  return ["text"];
}

function displayName(id: string): string {
  return id
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(" Free", " Free");
}

export class OpenCodeZenProvider implements LLMProvider {
  constructor(private env: Env) {}

  getProviderName() {
    return "opencode_zen" as const;
  }

  async discoverModels(): Promise<ModelMetadata[]> {
    try {

      assertSafeApiUrl(ZEN_MODELS_URL);

      const res = await fetch(ZEN_MODELS_URL, {
        headers: this.env.OPENCODE_API_KEY ? { authorization: `Bearer ${this.env.OPENCODE_API_KEY}` } : {},
      });
      if (!res.ok) {
        console.warn("zen discover http", res.status);
        return this.fallbackFree();
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      const ids = (data.data ?? []).map((m) => m.id);
      // If Zen API someday returns pricing, we would check it; today filter by suffix
      const free = ids.filter(isFreeZenModel);
      if (free.length === 0) return this.fallbackFree();
      return free.map((id) => ({
        provider: "opencode_zen" as const,
        provider_model_id: id,
        display_name: displayName(id),
        context_length: contextFor(id),
        capabilities: capabilitiesFor(id),
        input_price: "0",
        output_price: "0",
        is_free: true,
        free_status: "FREE" as const,
      }));
    } catch (e) {
      console.warn("zen discover error", e);
      return this.fallbackFree();
    }
  }

  private fallbackFree(): ModelMetadata[] {
    // Keep last-known free set so offline still benchmarks 9
    const ids = [
      "big-pickle",
      "deepseek-v4-flash-free",
      "x-preview-f-free",
      "muse-spark-1.2-contributor-free",
      "mimo-v2.5-free",
      "hy3-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "laguna-s-2.1-free",
    ];
    return ids.map((id) => ({
      provider: "opencode_zen" as const,
      provider_model_id: id,
      display_name: displayName(id),
      context_length: contextFor(id),
      capabilities: capabilitiesFor(id),
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
      provider: "opencode_zen",
      providerModelId: model.provider_model_id,
      apiUrl: ZEN_CHAT_URL,
      apiKey: this.env.OPENCODE_API_KEY,
      benchmark,
      extraHeaders: {},
    });
  }
}
