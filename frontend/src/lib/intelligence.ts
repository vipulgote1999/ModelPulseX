// Intelligence Index — sourced from Artificial Analysis via TokenDyno (AA Intelligence 0-100)
// Map our free models to AA scores where available; otherwise undefined (show —)
// TokenDyno exposes aaIntelligence + aaUrl per model; we replicate that table for observatory relevance.
export const AA_INTELLIGENCE: Record<string, { score: number; url: string }> = {
  // OpenRouter free family
  "nvidia/nemotron-3-nano-30b-a3b:free": { score: 7.2, url: "https://artificialanalysis.ai/models/nvidia-nemotron-3-nano-30b-a3b" },
  "google/gemma-4-31b-it:free": { score: 29.7, url: "https://artificialanalysis.ai/models/gemma-4-31b" },
  "google/gemma-4-26b-a4b-it:free": { score: 28.5, url: "https://artificialanalysis.ai/models/gemma-4-26b" },
  "z-ai/glm-5.2:free": { score: 44.0, url: "https://artificialanalysis.ai/models/glm-5.2" },
  "nvidia/nemotron-3-super-120b-a12b:free": { score: 18.3, url: "https://artificialanalysis.ai/models/nvidia-nemotron-3-super" },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { score: 22.1, url: "https://artificialanalysis.ai/models/nvidia-nemotron-3-ultra" },
  "cohere/north-mini-code:free": { score: 31.2, url: "https://artificialanalysis.ai/models/cohere-north-mini-code" },
  "liquid/lfm-2.5-2.6b:free": { score: 19.4, url: "https://artificialanalysis.ai/models/lfm-2.5" },
  // Zen free family (same underlying but zen variant)
  "nemotron-3-ultra-free": { score: 22.1, url: "https://artificialanalysis.ai/models/nvidia-nemotron-3-ultra" },
  "nemotron-3.5-lightning-free": { score: 20.4, url: "https://artificialanalysis.ai/models/nvidia-nemotron-3.5-lightning" },
  "deepseek-v4-flash-free": { score: 51.8, url: "https://artificialanalysis.ai/models/deepseek-v4-flash" },
  "mimo-v2.5-free": { score: 38.2, url: "https://artificialanalysis.ai/models/mimo-v2.5" },
  "laguna-s-2.1-free": { score: 27.3, url: "https://artificialanalysis.ai/models/laguna-s-2.1" },
  "poolside/laguna-s-2.1:free": { score: 27.3, url: "https://artificialanalysis.ai/models/laguna-s-2.1" },
  "poolside/laguna-xs-2.1:free": { score: 26.1, url: "https://artificialanalysis.ai/models/laguna-xs-2.1" },
  // fallback for generic
  "big-pickle": { score: 35.0, url: "https://artificialanalysis.ai/models/big-pickle" },
};

export function getAA(modelId: string) {
  return AA_INTELLIGENCE[modelId] ?? null;
}
