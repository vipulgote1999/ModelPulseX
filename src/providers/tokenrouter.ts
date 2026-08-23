import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";
// TrueRouter / TokenRouter — free token router
const MODELS_URL = "https://api.tokenrouter.com/v1/models";
const CHAT_URL = "https://api.tokenrouter.com/v1/chat/completions";
const FALLBACK = [
  { id: "llama3.1:8b", name: "Llama 3.1 8B (TokenRouter)", ctx: 131072 },
  { id: "qwen2.5-coder:7b", name: "Qwen 2.5 Coder 7B (TokenRouter)", ctx: 131072 },
  { id: "gemma3:4b", name: "Gemma 3 4B (TokenRouter)", ctx: 131072 },
];
export class TokenRouterProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "tokenrouter" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    if (!this.env.TOKENROUTER_API_KEY) return [];
    try {
      const r = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${this.env.TOKENROUTER_API_KEY}` } });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map(m=>m.id).filter(Boolean);
      if (!ids.length) return this.fallback();
      return ids.slice(0,10).map(id=>({ provider:"tokenrouter" as const, provider_model_id:id, display_name:id, context_length:131072, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[]{ return FALLBACK.map(m=>({ provider:"tokenrouter" as const, provider_model_id:m.id, display_name:m.name, context_length:m.ctx, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const })); }
  async getModelMetadata(id:string){ const a=await this.discoverModels(); return a.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"tokenrouter", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.TOKENROUTER_API_KEY as string|undefined, benchmark:b }); }
}
