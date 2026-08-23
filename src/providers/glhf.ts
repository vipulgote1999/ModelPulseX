import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";
const MODELS_URL = "https://glhf.chat/api/openai/v1/models";
const CHAT_URL = "https://glhf.chat/api/openai/v1/chat/completions";
const FALLBACK = [
  { id: "hf:meta-llama/Meta-Llama-3.1-8B-Instruct", name: "Llama 3.1 8B (GLHF)", ctx: 131072 },
  { id: "hf:google/gemma-2-9b-it", name: "Gemma 2 9B (GLHF)", ctx: 8192 },
  { id: "hf:mistralai/Mistral-7B-Instruct-v0.3", name: "Mistral 7B (GLHF)", ctx: 32768 },
];
export class GlhfProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "glhf" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      const r = await fetch(MODELS_URL, { headers: (this.env.GLHF_API_KEY ? { authorization: `Bearer ${this.env.GLHF_API_KEY}` } : {} as Record<string,string>) });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map(m=>m.id).filter(Boolean);
      if (!ids.length) return this.fallback();
      return ids.slice(0,10).map(id=>({ provider:"glhf" as const, provider_model_id:id, display_name:id, context_length:131072, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[]{ return FALLBACK.map(m=>({ provider:"glhf" as const, provider_model_id:m.id, display_name:m.name, context_length:m.ctx, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const })); }
  async getModelMetadata(id:string){ const a=await this.discoverModels(); return a.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"glhf", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.GLHF_API_KEY as string|undefined, benchmark:b }); }
}
