/** Single source of truth for providers: construction, verified-free hard filters.
 *  Adding a provider = one descriptor entry here (+ adapter file). Concurrency/RPM env
 *  keys are derived by convention via utils/concurrency (CONCURRENCY_KEYS / getRPMConfig).
 */
import type { Env, LLMProvider } from "../types";
import { OpenCodeZenProvider } from "./opencode-zen";
import { OpenRouterProvider } from "./openrouter";
import { GroqProvider } from "./groq";
import { CerebrasProvider } from "./cerebras";
import { GeminiProvider } from "./gemini";
import { NvidiaProvider } from "./nvidia";
import { SambanovaProvider } from "./sambanova";
import { MistralProvider } from "./mistral";
import { AgnesAiProvider } from "./agnes_ai";
import { AionLabsProvider } from "./aionlabs";
import { KiloCodeProvider } from "./kilocode";
import { GlhfProvider } from "./glhf";
import { NscaleProvider } from "./nscale";
import { SpekaProvider } from "./speka";
import { NexaApiProvider } from "./nexaapi";
import { OrcaRouterProvider } from "./orcarouter";
import { NineRouterProvider } from "./ninerouter";
import { TokenRouterProvider } from "./tokenrouter";
import { OllamaProvider } from "./ollama";

/** Verified free Ollama models — everything else on the public instance requires a subscription.
 *  Shared between the hard filter (queries) and the one-shot data fix. */
export const OLLAMA_FREE_MODELS = [
  "gemma4:31b",
  "minimax-m3",
  "gpt-oss:20b",
  "gpt-oss:120b",
  "nemotron-3-super",
  "nemotron-3-ultra",
  "nemotron-3-nano:30b",
] as const;

export interface ProviderDescriptor {
  name: string;
  create(env: Env): LLMProvider;
  /** SQL predicate (parameterized only by table alias) restricting this provider to
   *  verified-free model ids. Used in leaderboard/scheduler queries as an immediate
   *  hide of polluted rows even before discovery cleanup lands. */
  hardFreeFilter?(modelAlias: string): string;
}

export const PROVIDER_REGISTRY: ProviderDescriptor[] = [
  { name: "opencode_zen", create: (e) => new OpenCodeZenProvider(e) },
  { name: "openrouter", create: (e) => new OpenRouterProvider(e) },
  { name: "groq", create: (e) => new GroqProvider(e) },
  { name: "cerebras", create: (e) => new CerebrasProvider(e) },
  { name: "gemini", create: (e) => new GeminiProvider(e) },
  { name: "nvidia", create: (e) => new NvidiaProvider(e) },
  { name: "sambanova", create: (e) => new SambanovaProvider(e) },
  { name: "mistral", create: (e) => new MistralProvider(e) },
  { name: "agnes_ai", create: (e) => new AgnesAiProvider(e) },
  { name: "aionlabs", create: (e) => new AionLabsProvider(e) },
  { name: "kilocode", create: (e) => new KiloCodeProvider(e) },
  { name: "glhf", create: (e) => new GlhfProvider(e) },
  { name: "nscale", create: (e) => new NscaleProvider(e) },
  { name: "speka", create: (e) => new SpekaProvider(e) },
  { name: "nexaapi", create: (e) => new NexaApiProvider(e) },
  { name: "orcarouter", create: (e) => new OrcaRouterProvider(e) },
  { name: "ninerouter", create: (e) => new NineRouterProvider(e) },
  {
    name: "tokenrouter",
    create: (e) => new TokenRouterProvider(e),
    hardFreeFilter: (m) => `lower(${m}.provider_model_id) LIKE '%free'`,
  },
  {
    name: "ollama",
    create: (e) => new OllamaProvider(e),
    hardFreeFilter: (m) =>
      `${m}.provider_model_id IN (${OLLAMA_FREE_MODELS.map((id) => `'${id}'`).join(",")})`,
  },
];

/** AND-fragment applying every registered hard filter to a query joining providers+models.
 *  `exclude` omits one provider's filter (used where a caller already special-cases it). */
export function freeHardFilterWhere(providerAlias: string, modelAlias: string): string {
  const parts = PROVIDER_REGISTRY.filter((d) => d.hardFreeFilter).map(
    (d) => `(${providerAlias}.name != '${d.name}' OR ${d.hardFreeFilter!(modelAlias)})`,
  );
  return parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
}
