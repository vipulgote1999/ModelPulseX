import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Env,
  LLMProvider,
  ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";

const GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const GO_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions";

// Honest client identity. Go docs require callers to identify with their own
// user agent rather than a generic SDK name, plus a stable x-opencode-session
// per conversation. Each benchmark run is its own conversation, so the engine
// fresh-per-run session id complies; the adapter only sets the UA.
const GO_CLIENT_UA = "modelpulsex/1.0 (+https://modelpulsex.pages.dev)";

// Slow-cadence capability tag: TokenDyno benchmarks the priciest Go models
// every ~6h instead of the standard ~30m. Matched ids carry this capability
// so the scheduler can enforce the slower cadence (see e04s02 spec).
export const SLOW_CADENCE_CAPABILITY = "slow-cadence";

// Priciest Go models per the TokenDyno 6h policy; adjust from opencode.ai/docs/go pricing.
const GO_SLOW_CADENCE_RE = /(grok-4\.7|claude-haiku|max|ultra|deepseek-v4-pro)/i;

function isFreeGoModel(id: string): boolean {
  // Only the limited-time free models observed upstream carry the -free suffix
  // (step-5-preview-free, longcat-2.5-preview-free). Everything else is UNKNOWN:
  // never guess PAID or FREE on a subscription gateway.
  return id.endsWith("-free");
}

function capabilitiesFor(id: string): string[] {
  const caps = ["text"];
  const lower = id.toLowerCase();
  if (lower.includes("vision") || lower.includes("vl")) caps.push("vision");
  if (GO_SLOW_CADENCE_RE.test(id)) caps.push(SLOW_CADENCE_CAPABILITY);
  return caps;
}

export class OpenCodeGoProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName() {
    return "opencode_go" as const;
  }

  async discoverModels(): Promise<ModelMetadata[]> {
    // No key, no verification: a subscription gateway cannot be probed
    // anonymously, and unverified ids would be fabricated catalog rows.
    if (!this.env.OPENCODE_GO_API_KEY) return [];
    try {
      assertSafeApiUrl(GO_MODELS_URL);
      const res = await fetch(GO_MODELS_URL, {
        headers: { authorization: "Bearer " + this.env.OPENCODE_GO_API_KEY },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: Array<{ id: string }>,
        models?: Array<{ name: string }>,
      };
      const idsRaw = (data.data ?? []).map((m) => m.id).filter(Boolean);
      const idsTags = ((data as unknown as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name).filter(Boolean);
      const ids = idsRaw.length > 0 ? idsRaw : idsTags;
      return ids.map((id) => {
        const free = isFreeGoModel(id);
        return {
          provider: "opencode_go" as const,
          provider_model_id: id,
          display_name: id,
          context_length: 128000,
          capabilities: capabilitiesFor(id),
          input_price: null,
          output_price: null,
          is_free: free,
          free_status: free ? ("FREE" as const) : ("UNKNOWN" as const),
        };
      });
    } catch {
      return [];
    }
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
      provider: "opencode_go",
      providerModelId: model.provider_model_id,
      apiUrl: GO_CHAT_URL,
      apiKey: this.env.OPENCODE_GO_API_KEY,
      benchmark,
      extraHeaders: { "user-agent": GO_CLIENT_UA },
    });
  }
}
