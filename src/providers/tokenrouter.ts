import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";
// TrueRouter / TokenRouter — free token router
const MODELS_URL = "https://api.tokenrouter.com/v1/models";
const CHAT_URL = "https://api.tokenrouter.com/v1/chat/completions";
// Only models ending with free are to be benchmarked (per spec: never benchmark paid/unknown)
function isFreeTokenRouterId(id: string): boolean {
  const lower = id.toLowerCase().trim();
  return lower.endsWith(":free") || lower.endsWith("-free") || lower.endsWith("free");
}

const FALLBACK: Array<{ id: string; name: string; ctx: number }> = [
  // Verified free from live TokenRouter catalog (ending with :free / -free)
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni 30B Reasoning (free)", ctx: 256000 },
  { id: "qwen/qwen3.8-max-free", name: "Qwen 3.8 Max (free)", ctx: 131072 },
];
export class TokenRouterProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "tokenrouter" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      assertSafeApiUrl(MODELS_URL);

      const r = await fetch(MODELS_URL, { headers: (this.env.TOKENROUTER_API_KEY ? { authorization: `Bearer ${this.env.TOKENROUTER_API_KEY}` } : {} as Record<string,string>) });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map((m) => m.id).filter(Boolean).filter(isFreeTokenRouterId);
      if (!ids.length) return this.fallback();
      return ids.slice(0, 10).map((id) => ({
        provider: "tokenrouter" as const,
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
    // Fallback is also strictly free-suffix so we never benchmark paid models
    return FALLBACK.filter((m) => isFreeTokenRouterId(m.id)).map((m) => ({
      provider: "tokenrouter" as const,
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
  async getModelMetadata(id:string){ const a=await this.discoverModels(); return a.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"tokenrouter", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.TOKENROUTER_API_KEY as string|undefined, benchmark:b }); }
}
