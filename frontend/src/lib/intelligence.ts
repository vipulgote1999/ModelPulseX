// Intelligence Index + thinking metadata (e04s03 TokenDyno parity).
// Scores: Artificial Analysis Intelligence Index via TokenDyno live overview
// (api.ollamatps.com/sites/tokendyno/overview, CC-BY 4.0 dataset, generated
// 2026-10-12 from 71 rows, 43 scored models).
// Each score links to its Artificial Analysis model page. Entries without a
// TokenDyno row are dropped (no source, never stale-carry): gemma-4-26b,
// north-mini-code, lfm-2.5 and the laguna family lost their 2026-09-24 rows here.
// thinking: TokenDyno thinkingCapable OR-merged across provider rows (null when
// every row is null = unknown, never guessed). reasoningModel: aaReasoningModel
// with false winning (drives the non-reasoning note).
// Regenerate: re-run the e04s03 generator against the overview endpoint and diff.

export interface ModelIntelligence {
  score: number | null;
  url: string | null;
  thinking: boolean | null;
  reasoningModel: boolean | null;
}

interface IntelligenceEntry extends ModelIntelligence {
  aliases: string[];
}

const ENTRIES: IntelligenceEntry[] = [
  {
    aliases: ["claude-haiku-5-5"],
    score: 43.4,
    url: "https://artificialanalysis.ai/models/claude-haiku-5-5",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["deepseek-v4-flash", "deepseek-flash"],
    score: 34.3,
    url: "https://artificialanalysis.ai/models/deepseek-v4-flash",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["deepseek-v4-flash-vision-exp"],
    score: 34.8,
    url: "https://artificialanalysis.ai/models/deepseek-v4-flash-vision",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["deepseek-v4-pro", "deepseek-v4-pro:0813"],
    score: 36,
    url: "https://artificialanalysis.ai/models/deepseek-v4-pro",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["deepseek-v4.1-flash"],
    score: 39.5,
    url: "https://artificialanalysis.ai/models/deepseek-v4-1-flash",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["gemma4:31b", "google/gemma-4-31b-it:free"],
    score: 14.7,
    url: "https://artificialanalysis.ai/models/gemma-4-31b",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["glm-5.1"],
    score: 26.1,
    url: "https://artificialanalysis.ai/models/glm-5-1",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["glm-5.2", "z-ai/glm-5.2:free"],
    score: 33.7,
    url: "https://artificialanalysis.ai/models/glm-5-2",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["glm-5.3"],
    score: 44.8,
    url: "https://artificialanalysis.ai/models/glm-5-3",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["glm-5.3-flash"],
    score: 41.8,
    url: "https://artificialanalysis.ai/models/glm-5-3-flash",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["gpt-5.6-luna"],
    score: 37.3,
    url: "https://artificialanalysis.ai/models/gpt-5-6-luna",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["gpt-6-luna"],
    score: 38.1,
    url: "https://artificialanalysis.ai/models/gpt-6-luna",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["gpt-oss:120b"],
    score: 11.6,
    url: "https://artificialanalysis.ai/models/gpt-oss-120b",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["gpt-oss:20b"],
    score: 9,
    url: "https://artificialanalysis.ai/models/gpt-oss-20b",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["grok-4.6"],
    score: 44.3,
    url: "https://artificialanalysis.ai/models/grok-4-6",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["grok-4.7"],
    score: 46.4,
    url: "https://artificialanalysis.ai/models/grok-4-7",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["hy3"],
    score: 25.3,
    url: "https://artificialanalysis.ai/models/hy3",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["kimi-k2.6"],
    score: 27,
    url: "https://artificialanalysis.ai/models/kimi-k2-6",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["kimi-k2.7-code"],
    score: 25.8,
    url: "https://artificialanalysis.ai/models/kimi-k2-7-code",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["kimi-k3"],
    score: 43.6,
    url: "https://artificialanalysis.ai/models/kimi-k3",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["ling-3.1-flash-free"],
    score: 41.1,
    url: "https://artificialanalysis.ai/models/ling-3-1-flash",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["longcat-2.0"],
    score: 19.1,
    url: "https://artificialanalysis.ai/models/longcat-2-0",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["mimo-v2.5"],
    score: 25.2,
    url: "https://artificialanalysis.ai/models/mimo-v2-5-0424",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["mimo-v2.5-pro"],
    score: 26,
    url: "https://artificialanalysis.ai/models/mimo-v2-5-pro",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["mimo-v2.6-flash", "mimo-v2.6-flash-free"],
    score: 37.9,
    url: "https://artificialanalysis.ai/models/mimo-v2-6-flash",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["mimo-v2.6-pro"],
    score: 46.3,
    url: "https://artificialanalysis.ai/models/mimo-v2-6-pro",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["minimax-m2.5"],
    score: 22.8,
    url: "https://artificialanalysis.ai/models/minimax-m2-5",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["minimax-m2.7"],
    score: 22.8,
    url: "https://artificialanalysis.ai/models/minimax-m2-7",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["minimax-m3"],
    score: 29.2,
    url: "https://artificialanalysis.ai/models/minimax-m3",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["mistral-large-3:675b"],
    score: 9.3,
    url: "https://artificialanalysis.ai/models/mistral-large-3",
    thinking: false,
    reasoningModel: false,
  },
  {
    aliases: ["mistral-large-4"],
    score: 38.4,
    url: "https://artificialanalysis.ai/models/mistral-large-4",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["muse-spark-1.2-contributor"],
    score: 39.6,
    url: "https://artificialanalysis.ai/models/muse-spark-1-2",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["muse-spark-1.3-contributor", "muse-spark-1.3-contributor-free"],
    score: 48.1,
    url: "https://artificialanalysis.ai/models/muse-spark-1-3",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["nemotron-3-nano:30b", "nvidia/nemotron-3-nano-30b-a3b:free"],
    score: 6.8,
    url: "https://artificialanalysis.ai/models/nvidia-nemotron-3-nano-30b-a3b",
    thinking: true,
    reasoningModel: false,
  },
  {
    aliases: ["nemotron-3-super", "nvidia/nemotron-3-super-120b-a12b:free"],
    score: 12.8,
    url: "https://artificialanalysis.ai/models/nvidia-nemotron-3-super-120b-a12b",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["nemotron-3-ultra", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    score: 22.9,
    url: "https://artificialanalysis.ai/models/nvidia-nemotron-3-ultra-550b-a55b",
    thinking: true,
    reasoningModel: true,
  },
  {
    aliases: ["nemotron-3.5-lightning-free"],
    score: 12.9,
    url: "https://artificialanalysis.ai/models/nemotron-3-5-lightning",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["qwen3.6-plus"],
    score: 27,
    url: "https://artificialanalysis.ai/models/qwen3-6-plus",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["qwen3.7-max"],
    score: 29.5,
    url: "https://artificialanalysis.ai/models/qwen3-7-max",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["qwen3.7-plus"],
    score: 25.2,
    url: "https://artificialanalysis.ai/models/qwen3-7-plus",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["qwen3.8-flash"],
    score: 39.8,
    url: "https://artificialanalysis.ai/models/qwen3-8-flash-next",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["qwen3.8-max"],
    score: 45.4,
    url: "https://artificialanalysis.ai/models/qwen3-8-max",
    thinking: null,
    reasoningModel: true,
  },
  {
    aliases: ["step-5-preview-free"],
    score: 43.7,
    url: "https://artificialanalysis.ai/models/step-5",
    thinking: null,
    reasoningModel: true,
  },
];

const BY_ALIAS = new Map<string, IntelligenceEntry>();
for (const e of ENTRIES) for (const a of e.aliases) BY_ALIAS.set(a.toLowerCase(), e);

function normalize(id: string): string {
  return id.toLowerCase().replace(/(:free|-free)$/, "");
}

export function getAAMeta(modelId: string): ModelIntelligence | null {
  const hit = BY_ALIAS.get(modelId.toLowerCase()) ?? BY_ALIAS.get(normalize(modelId));
  if (!hit) return null;
  return { score: hit.score, url: hit.url, thinking: hit.thinking, reasoningModel: hit.reasoningModel };
}

export function getAA(modelId: string): { score: number; url: string } | null {
  const m = getAAMeta(modelId);
  if (m == null || m.score == null || m.url == null) return null;
  return { score: m.score, url: m.url };
}

/** All entries (tests + future model pages). Treat as read-only. */
export const INTELLIGENCE_ENTRIES: ReadonlyArray<IntelligenceEntry> = ENTRIES;
