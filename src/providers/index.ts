/** Provider access built on the registry: O(1) lookup, constructed once per env instance.
 *  Previously getProviders rebuilt all 19 adapters and providerFor scanned them linearly
 *  on every benchmark job. */
import type { Env, LLMProvider, ModelMetadata } from "../types";
import { PROVIDER_REGISTRY } from "./registry";

// One adapter-instance map per distinct env object (worker invocation scope).
const cache = new WeakMap<object, Map<string, LLMProvider>>();

function providersMap(env: Env): Map<string, LLMProvider> {
  let m = cache.get(env);
  if (!m) {
    m = new Map<string, LLMProvider>();
    for (const d of PROVIDER_REGISTRY) m.set(d.name, d.create(env));
    cache.set(env, m);
  }
  return m;
}

export function getProviders(env: Env): LLMProvider[] {
  return Array.from(providersMap(env).values());
}

export function providerFor(name: string, env: Env): LLMProvider | null {
  return providersMap(env).get(name) ?? null;
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
