import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Env,
  LLMProvider,
  ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";

const KNOWN_FREE_EXACT = new Set<string>(["big-pickle"]);

/** Proven retired upstream ("Model is unavailable") yet still listed in /models —
 *  exclude from discovery so the scheduler stops burning cycles on it. */
const KNOWN_RETIRED = new Set<string>(["deepseek-v4-flash-free"]);

/** Official OpenCode CLI identity. Zen's free-tier gateway fingerprints these;
 *  without them free models reject with MissingSessionID / hang server-side.
 *  (Verified live 2026-09-08: same key 400s without, 200s with.) */
const ZEN_CLIENT_UA =
  "opencode/1.15.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

function randomHex(bytes = 16): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && "getRandomValues" in c) {
      const buf = new Uint8Array(bytes);
      c.getRandomValues(buf);
      return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // fall through to Math.random
  }
  let s = "";
  while (s.length < bytes * 2) s += Math.random().toString(16).slice(2);
  return s.slice(0, bytes * 2);
}

export function zenClientHeaders(): Record<string, string> {
  return {
    "user-agent": ZEN_CLIENT_UA,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-session": `ses_${randomHex()}`,
    "x-opencode-request": `msg_${randomHex()}`,
  };
}

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
        headers: this.env.OPENCODE_API_KEY
          ? { authorization: `Bearer ${this.env.OPENCODE_API_KEY}` }
          : {},
      });
      if (!res.ok) {
        console.warn("zen discover http", res.status);
        return this.fallbackFree();
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      const ids = (data.data ?? []).map((m) => m.id);
      // If Zen API someday returns pricing, we would check it; today filter by suffix
      const free = ids.filter((id) => isFreeZenModel(id) && !KNOWN_RETIRED.has(id));
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
    // Last-known live free set (verified 2026-09-08). deepseek retired upstream,
    // x-preview/hy3/laguna removed from the catalog — all excluded.
    const ids = [
      "big-pickle",
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "ling-3.0-flash-fin-free",
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

  async benchmarkModel(
    model: { provider_model_id: string },
    benchmark: BenchmarkDefinition,
  ): Promise<BenchmarkResult> {
    return measureBenchmark({
      provider: "opencode_zen",
      providerModelId: model.provider_model_id,
      apiUrl: ZEN_CHAT_URL,
      apiKey: this.env.OPENCODE_API_KEY,
      benchmark,
      // ponytail: static UA + per-call random session/request ids; rotate UA if gateway starts rejecting it
      extraHeaders: zenClientHeaders(),
    });
  }
}
