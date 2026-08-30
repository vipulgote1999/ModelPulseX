import type {
    BenchmarkDefinition,
    BenchmarkResult,
    Env,
    LLMProvider,
    ModelMetadata,
} from "../types";
import { measureBenchmark, assertSafeApiUrl } from "../benchmark/engine";
const MODELS_URL = "https://api.aionlabs.ai/v1/models";
const CHAT_URL = "https://api.aionlabs.ai/v1/chat/completions";
const VERIFIED_FREE = new Set<string>([
    "aion-3-0",
    "aion-3-0-mini",
    "aion-2-0",
    "aion-2-5",
    "aion-rp-1-0-8b",
    "aion-1-mini",
    "aion-1-large",
]);
const FALLBACK = [
    { id: "aion-3-0", name: "Aion 3.0", ctx: 131072 },
    { id: "aion-3-0-mini", name: "Aion 3.0 Mini", ctx: 131072 },
    { id: "aion-2-0", name: "Aion 2.0", ctx: 131072 },
    { id: "aion-2-5", name: "Aion 2.5", ctx: 131072 },
    { id: "aion-rp-1-0-8b", name: "Aion RP 1.0 8B", ctx: 32768 },
];
function toMeta(id: string): ModelMetadata {
    const isFree = VERIFIED_FREE.has(id);
    return {
        provider: "aionlabs" as const,
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
export class AionLabsProvider implements LLMProvider {
    constructor(private env: Env) {}
    getProviderName() {
        return "aionlabs" as const;
    }
    async discoverModels(): Promise<ModelMetadata[]> {
        try {
            assertSafeApiUrl(MODELS_URL);

            const r = await fetch(MODELS_URL, {
                headers: this.env.AIONLABS_API_KEY
                    ? { authorization: `Bearer ${this.env.AIONLABS_API_KEY}` }
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
            provider: "aionlabs" as const,
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
            provider: "aionlabs",
            providerModelId: m.provider_model_id,
            apiUrl: CHAT_URL,
            apiKey: this.env.AIONLABS_API_KEY as string | undefined,
            benchmark: b,
        });
    }
}
