import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";
const MODELS_URL = "https://api.nexa-api.com/v1/models";
const CHAT_URL = "https://api.nexa-api.com/v1/chat/completions";
const FALLBACK = [
  { id: "nexa-llama-3.1-8b", name: "Nexa Llama 3.1 8B", ctx: 131072 },
  { id: "nexa-qwen-2.5-7b", name: "Nexa Qwen 2.5 7B", ctx: 131072 },
];
export class NexaApiProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "nexaapi" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      assertSafeApiUrl(MODELS_URL);

      const r = await fetch(MODELS_URL, { headers: (this.env.NEXAAPI_API_KEY ? { authorization: `Bearer ${this.env.NEXAAPI_API_KEY}` } : {} as Record<string,string>) });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map(m=>m.id).filter(Boolean);
      if (!ids.length) return this.fallback();
      return ids.slice(0,10).map(id=>({ provider:"nexaapi" as const, provider_model_id:id, display_name:id, context_length:131072, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[]{ return FALLBACK.map(m=>({ provider:"nexaapi" as const, provider_model_id:m.id, display_name:m.name, context_length:m.ctx, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const })); }
  async getModelMetadata(id:string){ const a=await this.discoverModels(); return a.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"nexaapi", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.NEXAAPI_API_KEY as string|undefined, benchmark:b }); }
}
