import type {
    BenchmarkDefinition,
    BenchmarkResult,
    Env,
    LLMProvider,
    ModelMetadata,
} from "../types";
import { measureBenchmark } from "../benchmark/engine";
const MODELS_URL = "https://inference.api.nscale.com/v1/models";
const CHAT_URL = "https://inference.api.nscale.com/v1/chat/completions";
const VERIFIED_FREE = new Set<string>([
    "meta-llama/Llama-3.3-70B-Instruct",
    "meta-llama/Llama-3.1-70B-Instruct",
    "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
]);
const FALLBACK = [
    {
        id: "meta-llama/Llama-3.3-70B-Instruct",
        name: "Llama 3.3 70B (Nscale Free)",
        ctx: 131072,
    },
    {
        id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        name: "Qwen3 Coder 30B (Nscale Free)",
        ctx: 262144,
    },
    {
        id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
        name: "DeepSeek R1 70B (Nscale Free)",
        ctx: 131072,
    },
];
function toMeta(id: string): ModelMetadata {
    const isFree = VERIFIED_FREE.has(id);
    return {
        provider: "nscale" as const,
        provider_model_id: id,
        display_name: id,
        context_length: 131072,
        capabilities: ["text"],
        input_price: isFree ? "0" : "0.001",
        output_price: isFree ? "0" : "0.002",
        is_free: isFree,
        free_status: isFree ? "FREE" : ("PAID" as const),
    };
}
export class NscaleProvider implements LLMProvider {
    constructor(private env: Env) {}
    getProviderName() {
        return "nscale" as const;
    }
    async discoverModels(): Promise<ModelMetadata[]> {
        try {
            const r = await fetch(MODELS_URL, {
                headers: this.env.NSCALE_API_KEY
                    ? { authorization: `Bearer ${this.env.NSCALE_API_KEY}` }
                    : ({} as Record<string, string>),
            });
            if (!r.ok) return this.fallback();
            const j = (await r.json()) as { data?: Array<{ id: string }> };
            const ids = (j.data ?? []).map((m) => m.id).filter(Boolean);
            if (!ids.length) return this.fallback();
            return ids.map(toMeta);
        } catch {
            return this.fallback();
        }
    }
    private fallback(): ModelMetadata[] {
        return FALLBACK.map((m) => ({
            provider: "nscale" as const,
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
    async getModelMetadata(id: string) {
        const a = await this.discoverModels();
        return a.find((m) => m.provider_model_id === id) ?? null;
    }
    async benchmarkModel(
        m: { provider_model_id: string },
        b: BenchmarkDefinition,
    ): Promise<BenchmarkResult> {
        return measureBenchmark({
            provider: "nscale",
            providerModelId: m.provider_model_id,
            apiUrl: CHAT_URL,
            apiKey: this.env.NSCALE_API_KEY as string | undefined,
            benchmark: b,
        });
    }
}
