import type {
    BenchmarkDefinition,
    BenchmarkResult,
    Env,
    LLMProvider,
    ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";
const MODELS_URL = "https://apihub.agnes-ai.com/v1/models";
const CHAT_URL = "https://apihub.agnes-ai.com/v1/chat/completions";
const VERIFIED_FREE = new Set<string>([
    "agnes-2.0-flash",
    "agnes-1.5-flash",
    "agnes-image-2.0-flash",
    "agnes-image-2.1-flash",
    "agnes-video-v2.0",
]);
const FALLBACK = [
    { id: "agnes-2.0-flash", name: "Agnes 2.0 Flash", ctx: 262144 },
    { id: "agnes-1.5-flash", name: "Agnes 1.5 Flash", ctx: 262144 },
    { id: "agnes-image-2.0-flash", name: "Agnes Image 2.0", ctx: 4096 },
    { id: "agnes-image-2.1-flash", name: "Agnes Image 2.1", ctx: 4096 },
    { id: "agnes-video-v2.0", name: "Agnes Video 2.0", ctx: 4096 },
];
function toMeta(id: string): ModelMetadata {
    const isFree = VERIFIED_FREE.has(id);
    return {
        provider: "agnes_ai" as const,
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
export class AgnesAiProvider implements LLMProvider {
    constructor(private env: Env) {}
    getProviderName() {
        return "agnes_ai" as const;
    }
    async discoverModels(): Promise<ModelMetadata[]> {
        try {
            assertSafeApiUrl(MODELS_URL);

            const r = await fetch(MODELS_URL, {
                headers: this.env.AGNES_API_KEY
                    ? { authorization: `Bearer ${this.env.AGNES_API_KEY}` }
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
            provider: "agnes_ai" as const,
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
        const all = await this.discoverModels();
        return all.find((m) => m.provider_model_id === id) ?? null;
    }
    async benchmarkModel(
        m: { provider_model_id: string },
        b: BenchmarkDefinition,
    ): Promise<BenchmarkResult> {
        return measureBenchmark({
            provider: "agnes_ai",
            providerModelId: m.provider_model_id,
            apiUrl: CHAT_URL,
            apiKey: this.env.AGNES_API_KEY as string | undefined,
            benchmark: b,
        });
    }
}
