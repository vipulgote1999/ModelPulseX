import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";
// 9Router / OmniRoute share same cloud endpoint; local http://localhost:20128/v1 is self-hosted variant
const MODELS_URL = "https://9router.com/v1/models";
const CHAT_URL = "https://9router.com/v1/chat/completions";
const FALLBACK = [
  { id: "9router-llama-3.1-8b", name: "9Router Llama 3.1 8B", ctx: 131072 },
  { id: "9router-qwen-2.5-7b", name: "9Router Qwen 2.5 7B", ctx: 131072 },
];
export class NineRouterProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "ninerouter" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      const r = await fetch(MODELS_URL, { headers: (this.env.NINEROUTER_API_KEY ? { authorization: `Bearer ${this.env.NINEROUTER_API_KEY}` } : {} as Record<string,string>) });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map(m=>m.id).filter(Boolean);
      if (!ids.length) return this.fallback();
      return ids.slice(0,10).map(id=>({ provider:"ninerouter" as const, provider_model_id:id, display_name:id, context_length:131072, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[]{ return FALLBACK.map(m=>({ provider:"ninerouter" as const, provider_model_id:m.id, display_name:m.name, context_length:m.ctx, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const })); }
  async getModelMetadata(id:string){ const a=await this.discoverModels(); return a.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"ninerouter", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.NINEROUTER_API_KEY as string|undefined, benchmark:b }); }
}
