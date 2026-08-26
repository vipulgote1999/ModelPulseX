import type {
    BenchmarkDefinition,
    BenchmarkResult,
    Env,
    LLMProvider,
    ModelMetadata,
} from "../types";
import { measureBenchmark } from "../benchmark/engine";
const MODELS_URL = "https://api.kilo.ai/api/gateway/models";
const CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
const FALLBACK = [
    {
        id: "inclusionai/ling-3.0-flash:free",
        name: "Ling 3.0 Flash (free)",
        ctx: 262144,
    },
    {
        id: "nvidia/nemotron-3-ultra-550b-a55b:free",
        name: "Nemotron 3 Ultra (free)",
        ctx: 1000000,
    },
    {
        id: "poolside/laguna-s-2.1:free",
        name: "Laguna S 2.1 (free)",
        ctx: 262144,
    },
];
function isFreeKilo(id: string) {
    const lower = id.toLowerCase().trim();
    return (
        lower.endsWith(":free") ||
        lower.endsWith("-free") ||
        lower.endsWith("/free")
    );
}
function toMeta(id: string): ModelMetadata {
    const isFree = isFreeKilo(id);
    return {
        provider: "kilocode" as const,
        provider_model_id: id,
        display_name: id,
        context_length: 131072,
        capabilities: ["text"],
        input_price: isFree ? "0" : "0.002",
        output_price: isFree ? "0" : "0.006",
        is_free: isFree,
        free_status: isFree ? "FREE" : ("PAID" as const),
    };
}
export class KiloCodeProvider implements LLMProvider {
    constructor(private env: Env) {}
    getProviderName() {
        return "kilocode" as const;
    }
    async discoverModels(): Promise<ModelMetadata[]> {
        try {
            const r = await fetch(MODELS_URL, {
                headers: this.env.KILOCODE_API_KEY
                    ? { authorization: `Bearer ${this.env.KILOCODE_API_KEY}` }
                    : ({} as Record<string, string>),
            });
            if (!r.ok) return this.fallback();
            const j = (await r.json()) as { data?: Array<{ id: string }> };
            const ids = (j.data ?? []).map((m) => m.id).filter(Boolean);
            if (!ids.length) return this.fallback();
            // Only free variants: must end with -free / :free / /free (case-insensitive) per gateway spec
            const freeIds = ids.filter(isFreeKilo);
            if (freeIds.length === 0) return this.fallback();
            return freeIds.map(toMeta);
        } catch {
            return this.fallback();
        }
    }
    private fallback(): ModelMetadata[] {
        return FALLBACK.map((m) => ({
            provider: "kilocode" as const,
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
            provider: "kilocode",
            providerModelId: m.provider_model_id,
            apiUrl: CHAT_URL,
            apiKey: this.env.KILOCODE_API_KEY as string | undefined,
            benchmark: b,
        });
    }
}
