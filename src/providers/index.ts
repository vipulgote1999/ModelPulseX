import type { Env, LLMProvider, ModelMetadata } from "../types";
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

export function getProviders(env: Env): LLMProvider[] {
  return [
    new OpenCodeZenProvider(env),
    new OpenRouterProvider(env),
    new GroqProvider(env),
    new CerebrasProvider(env),
    new GeminiProvider(env),
    new NvidiaProvider(env),
    new SambanovaProvider(env),
    new MistralProvider(env),
    new AgnesAiProvider(env),
    new AionLabsProvider(env),
    new KiloCodeProvider(env),
    new GlhfProvider(env),
    new NscaleProvider(env),
    new SpekaProvider(env),
    new NexaApiProvider(env),
    new OrcaRouterProvider(env),
    new NineRouterProvider(env),
    new TokenRouterProvider(env),
    new OllamaProvider(env),
  ];
}

export async function discoverAll(env: Env): Promise<ModelMetadata[]> {
  const providers = getProviders(env);
  const results = await Promise.allSettled(providers.map((p) => p.discoverModels()));
  const out: ModelMetadata[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.error("discover failed", r.reason);
  }
  return out;
}

// helper to get provider by name
export function providerFor(name: string, env: Env): LLMProvider | null {
  const ps = getProviders(env);
  return ps.find((p) => p.getProviderName() === name) ?? null;
}
