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
  /** Base URL without trailing slash, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  /** Full models listing URL */
  modelsUrl: string;
  /** Full chat completions URL */
  chatUrl: string;
  /** SQL predicate (parameterized only by table alias) restricting this provider to
   *  verified-free model ids. Used in leaderboard/scheduler queries as an immediate
   *  hide of polluted rows even before discovery cleanup lands. */
  hardFreeFilter?(modelAlias: string): string;
}

/** Central endpoint table — single source of truth for admin display and provider wiring.
 *  Keep in sync with the const URLs inside each adapter file. */
export const PROVIDER_ENDPOINTS: Record<
  string,
  { baseUrl: string; modelsUrl: string; chatUrl: string }
> = {
  opencode_zen: {
    baseUrl: "https://opencode.ai/zen/v1",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    chatUrl: "https://opencode.ai/zen/v1/chat/completions",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    chatUrl: "https://api.groq.com/openai/v1/chat/completions",
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    modelsUrl: "https://api.cerebras.ai/v1/models",
    chatUrl: "https://api.cerebras.ai/v1/chat/completions",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    chatUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelsUrl: "https://integrate.api.nvidia.com/v1/models",
    chatUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  },
  sambanova: {
    baseUrl: "https://api.sambanova.ai/v1",
    modelsUrl: "https://api.sambanova.ai/v1/models",
    chatUrl: "https://api.sambanova.ai/v1/chat/completions",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    modelsUrl: "https://api.mistral.ai/v1/models",
    chatUrl: "https://api.mistral.ai/v1/chat/completions",
  },
  agnes_ai: {
    baseUrl: "https://apihub.agnes-ai.com/v1",
    modelsUrl: "https://apihub.agnes-ai.com/v1/models",
    chatUrl: "https://apihub.agnes-ai.com/v1/chat/completions",
  },
  aionlabs: {
    baseUrl: "https://api.aionlabs.ai/v1",
    modelsUrl: "https://api.aionlabs.ai/v1/models",
    chatUrl: "https://api.aionlabs.ai/v1/chat/completions",
  },
  kilocode: {
    baseUrl: "https://api.kilo.ai/api/gateway",
    modelsUrl: "https://api.kilo.ai/api/gateway/models",
    chatUrl: "https://api.kilo.ai/api/gateway/chat/completions",
  },
  glhf: {
    baseUrl: "https://glhf.chat/api/openai/v1",
    modelsUrl: "https://glhf.chat/api/openai/v1/models",
    chatUrl: "https://glhf.chat/api/openai/v1/chat/completions",
  },
  nscale: {
    baseUrl: "https://inference.api.nscale.com/v1",
    modelsUrl: "https://inference.api.nscale.com/v1/models",
    chatUrl: "https://inference.api.nscale.com/v1/chat/completions",
  },
  speka: {
    baseUrl: "https://speka.me/v1",
    modelsUrl: "https://speka.me/v1/models",
    chatUrl: "https://speka.me/v1/chat/completions",
  },
  nexaapi: {
    baseUrl: "https://api.nexa-api.com/v1",
    modelsUrl: "https://api.nexa-api.com/v1/models",
    chatUrl: "https://api.nexa-api.com/v1/chat/completions",
  },
  orcarouter: {
    baseUrl: "https://api.orcarouter.ai/v1",
    modelsUrl: "https://api.orcarouter.ai/v1/models",
    chatUrl: "https://api.orcarouter.ai/v1/chat/completions",
  },
  ninerouter: {
    baseUrl: "https://9router.com/v1",
    modelsUrl: "https://9router.com/v1/models",
    chatUrl: "https://9router.com/v1/chat/completions",
  },
  tokenrouter: {
    baseUrl: "https://api.tokenrouter.com/v1",
    modelsUrl: "https://api.tokenrouter.com/v1/models",
    chatUrl: "https://api.tokenrouter.com/v1/chat/completions",
  },
  ollama: {
    baseUrl: "https://ollama.com/v1",
    modelsUrl: "https://ollama.com/v1/models",
    chatUrl: "https://ollama.com/v1/chat/completions",
  },
};

export function getProviderEndpoint(
  name: string,
): { baseUrl: string; modelsUrl: string; chatUrl: string } | null {
  return PROVIDER_ENDPOINTS[name] ?? null;
}

export const PROVIDER_REGISTRY: ProviderDescriptor[] = [
  {
    name: "opencode_zen",
    create: (e) => new OpenCodeZenProvider(e),
    ...PROVIDER_ENDPOINTS["opencode_zen"],
  },
  {
    name: "openrouter",
    create: (e) => new OpenRouterProvider(e),
    ...PROVIDER_ENDPOINTS["openrouter"],
  },
  {
    name: "groq",
    create: (e) => new GroqProvider(e),
    ...PROVIDER_ENDPOINTS["groq"],
  },
  {
    name: "cerebras",
    create: (e) => new CerebrasProvider(e),
    ...PROVIDER_ENDPOINTS["cerebras"],
  },
  {
    name: "gemini",
    create: (e) => new GeminiProvider(e),
    ...PROVIDER_ENDPOINTS["gemini"],
  },
  {
    name: "nvidia",
    create: (e) => new NvidiaProvider(e),
    ...PROVIDER_ENDPOINTS["nvidia"],
  },
  {
    name: "sambanova",
    create: (e) => new SambanovaProvider(e),
    ...PROVIDER_ENDPOINTS["sambanova"],
  },
  {
    name: "mistral",
    create: (e) => new MistralProvider(e),
    ...PROVIDER_ENDPOINTS["mistral"],
  },
  {
    name: "agnes_ai",
    create: (e) => new AgnesAiProvider(e),
    ...PROVIDER_ENDPOINTS["agnes_ai"],
  },
  {
    name: "aionlabs",
    create: (e) => new AionLabsProvider(e),
    ...PROVIDER_ENDPOINTS["aionlabs"],
  },
  {
    name: "kilocode",
    create: (e) => new KiloCodeProvider(e),
    ...PROVIDER_ENDPOINTS["kilocode"],
    hardFreeFilter: (m) =>
      `(lower(${m}.provider_model_id) LIKE '%:free' OR lower(${m}.provider_model_id) LIKE '%-free' OR lower(${m}.provider_model_id) LIKE '%/free')`,
  },
  {
    name: "glhf",
    create: (e) => new GlhfProvider(e),
    ...PROVIDER_ENDPOINTS["glhf"],
  },
  {
    name: "nscale",
    create: (e) => new NscaleProvider(e),
    ...PROVIDER_ENDPOINTS["nscale"],
  },
  {
    name: "speka",
    create: (e) => new SpekaProvider(e),
    ...PROVIDER_ENDPOINTS["speka"],
  },
  {
    name: "nexaapi",
    create: (e) => new NexaApiProvider(e),
    ...PROVIDER_ENDPOINTS["nexaapi"],
  },
  {
    name: "orcarouter",
    create: (e) => new OrcaRouterProvider(e),
    ...PROVIDER_ENDPOINTS["orcarouter"],
  },
  {
    name: "ninerouter",
    create: (e) => new NineRouterProvider(e),
    ...PROVIDER_ENDPOINTS["ninerouter"],
  },
  {
    name: "tokenrouter",
    create: (e) => new TokenRouterProvider(e),
    ...PROVIDER_ENDPOINTS["tokenrouter"],
    hardFreeFilter: (m) => `lower(${m}.provider_model_id) LIKE '%free'`,
  },
  {
    name: "ollama",
    create: (e) => new OllamaProvider(e),
    ...PROVIDER_ENDPOINTS["ollama"],
    hardFreeFilter: (m) =>
      `${m}.provider_model_id IN (${OLLAMA_FREE_MODELS.map((id) => `'${id}'`).join(",")})`,
  },
];

/** AND-fragment applying every registered hard filter to a query joining providers+models.
 *  `exclude` omits one provider's filter (used where a caller already special-cases it). */
export function freeHardFilterWhere(
  providerAlias: string,
  modelAlias: string,
): string {
  const parts = PROVIDER_REGISTRY.filter((d) => d.hardFreeFilter).map(
    (d) =>
      `(${providerAlias}.name != '${d.name}' OR ${d.hardFreeFilter!(modelAlias)})`,
  );
  return parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
}
