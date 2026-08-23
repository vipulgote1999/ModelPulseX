import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";
const MODELS_URL = "https://apihub.agnes-ai.com/v1/models";
const CHAT_URL = "https://apihub.agnes-ai.com/v1/chat/completions";
const FALLBACK = [
  { id: "llama-3.1-8b-instruct", name: "Llama 3.1 8B", ctx: 131072 },
  { id: "qwen2.5-7b-instruct", name: "Qwen 2.5 7B", ctx: 131072 },
  { id: "gemma-2-9b-it", name: "Gemma 2 9B", ctx: 8192 },
];
export class AgnesAiProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "agnes_ai" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    if (!this.env.AGNES_API_KEY) return [];
    try {
      const r = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${this.env.AGNES_API_KEY}` } });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map(m=>m.id).filter(Boolean);
      if (!ids.length) return this.fallback();
      return ids.slice(0,10).map(id=>({ provider:"agnes_ai" as const, provider_model_id:id, display_name:id, context_length:131072, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[] {
    return FALLBACK.map(m=>({ provider:"agnes_ai" as const, provider_model_id:m.id, display_name:m.name, context_length:m.ctx, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
  }
  async getModelMetadata(id:string){ const all=await this.discoverModels(); return all.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"agnes_ai", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.AGNES_API_KEY as string|undefined, benchmark:b }); }
}
