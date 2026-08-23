import type { BenchmarkDefinition, BenchmarkResult, Env, LLMProvider, ModelMetadata } from "../types";
import { measureBenchmark } from "../benchmark/engine";
// Kilo Code via AIML API
const MODELS_URL = "https://api.aimlapi.com/v1/models";
const CHAT_URL = "https://api.aimlapi.com/v1/chat/completions";
const FALLBACK = [
  { id: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", name: "Llama 3.1 8B Turbo", ctx: 131072 },
  { id: "google/gemma-2-27b-it", name: "Gemma 2 27B", ctx: 8192 },
  { id: "mistralai/Mistral-7B-Instruct-v0.2", name: "Mistral 7B", ctx: 32768 },
];
export class KiloCodeProvider implements LLMProvider {
  constructor(private env: Env) {}
  getProviderName(){ return "kilocode" as const; }
  async discoverModels(): Promise<ModelMetadata[]> {
    try {
      const r = await fetch(MODELS_URL, { headers: (this.env.KILOCODE_API_KEY ? { authorization: `Bearer ${this.env.KILOCODE_API_KEY}` } : {} as Record<string,string>) });
      if (!r.ok) return this.fallback();
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map(m=>m.id).filter(Boolean);
      if (!ids.length) return this.fallback();
      return ids.slice(0,10).map(id=>({ provider:"kilocode" as const, provider_model_id:id, display_name:id, context_length:131072, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const }));
    } catch { return this.fallback(); }
  }
  private fallback(): ModelMetadata[]{ return FALLBACK.map(m=>({ provider:"kilocode" as const, provider_model_id:m.id, display_name:m.name, context_length:m.ctx, capabilities:["text"], input_price:"0", output_price:"0", is_free:true, free_status:"FREE" as const })); }
  async getModelMetadata(id:string){ const a=await this.discoverModels(); return a.find(m=>m.provider_model_id===id)??null; }
  async benchmarkModel(m:{provider_model_id:string}, b:BenchmarkDefinition):Promise<BenchmarkResult>{ return measureBenchmark({ provider:"kilocode", providerModelId:m.provider_model_id, apiUrl:CHAT_URL, apiKey:this.env.KILOCODE_API_KEY as string|undefined, benchmark:b }); }
}
