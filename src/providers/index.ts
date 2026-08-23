import type { Env, LLMProvider, ModelMetadata } from "../types";
import { OpenCodeZenProvider } from "./opencode-zen";
import { OpenRouterProvider } from "./openrouter";

export function getProviders(env: Env): LLMProvider[] {
  return [new OpenCodeZenProvider(env), new OpenRouterProvider(env)];
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
