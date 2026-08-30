import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";
const MODELS_URL = "https://api.orcarouter.ai/v1/models";
const CHAT_URL = "https://api.orcarouter.ai/v1/chat/completions";
const FALLBACK = [
  { id: "orca-llama-3.1-70b", name: "Orca Llama 3.1 70B", ctx: 131072 },
  { id: "orca-gemma-2-27b", name: "Orca Gemma 2 27B", ctx: 8192 },
  { id: "orca-mistral-7b", name: "Orca Mistral 7B", ctx: 32768 },
];
export class OrcaRouterProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "orcarouter" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      assertSafeApiUrl(MODELS_URL);

      const r = await fetch(MODELS_URL, { headers: (this.env.ORCAROUTER_API_KEY ? { authorization: `Bearer ${this.env.ORCAROUTER_API_KEY}` } : {} as Record<string,string>) });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map(m=>m.id).filter(Boolean);
      if (!ids.length) return this.fallback();
      return ids.slice(0,10).map(id=>({ provider:"orcarouter" as const, provider_model_id:id, display_name:id, context_length:131072, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[]{ return FALLBACK.map(m=>({ provider:"orcarouter" as const, provider_model_id:m.id, display_name:m.name, context_length:m.ctx, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const })); }
  async getModelMetadata(id:string){ const a=await this.discoverModels(); return a.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"orcarouter", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.ORCAROUTER_API_KEY as string|undefined, benchmark:b }); }
}
