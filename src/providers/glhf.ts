import type {
    BenchmarkDefinition,
    BenchmarkResult,
    Env,
    LLMProvider,
    ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";
const MODELS_URL = "https://glhf.chat/api/openai/v1/models";
const CHAT_URL = "https://glhf.chat/api/openai/v1/chat/completions";
const VERIFIED_FREE = new Set<string>([
    "hf:meta-llama/Meta-Llama-3.1-70B-Instruct",
    "hf:meta-llama/Meta-Llama-3.1-70B-Instruct",
    "meta-llama/Meta-Llama-3.1-70B-Instruct",
    "mistralai/Mixtral-8x7B-Instruct-v0.1",
]);
const FALLBACK = [
    {
        id: "hf:meta-llama/Meta-Llama-3.1-70B-Instruct",
        name: "Llama 3.1 70B (GLHF Free)",
        ctx: 131072,
    },
    {
        id: "hf:mistralai/Mixtral-8x7B-Instruct-v0.1",
        name: "Mixtral 8x7B (GLHF Free)",
        ctx: 32768,
    },
];
function toMeta(id: string): ModelMetadata {
    const isFree =
        VERIFIED_FREE.has(id) ||
        id.includes("Llama-3.1-70B") ||
        id.includes("Mixtral-8x7B");
    return {
        provider: "glhf" as const,
        provider_model_id: id,
        display_name: id,
        context_length: 131072,
        capabilities: ["text"],
        input_price: isFree ? "0" : "0.001",
        output_price: isFree ? "0" : "0.001",
        is_free: isFree,
        free_status: isFree ? "FREE" : ("PAID" as const),
    };
}
export class GlhfProvider implements LLMProvider {
    constructor(private env: Env) {}
    getProviderName() {
        return "glhf" as const;
    }
    async discoverModels(): Promise<ModelMetadata[]> {
        try {
            assertSafeApiUrl(MODELS_URL);

            const r = await fetch(MODELS_URL, {
                headers: this.env.GLHF_API_KEY
                    ? { authorization: `Bearer ${this.env.GLHF_API_KEY}` }
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
            provider: "glhf" as const,
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
            provider: "glhf",
            providerModelId: m.provider_model_id,
            apiUrl: CHAT_URL,
            apiKey: this.env.GLHF_API_KEY as string | undefined,
            benchmark: b,
        });
    }
}
