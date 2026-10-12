// Static provider billing + sampling notes (e04s04 pricing page + footer).
// Billing facts sourced from provider docs (see e04s02 spec and round-2 research);
// per-model token rates come from /api/models discovery payloads, never here.

export interface ProviderBlurb {
  billing: string;
  cadence: string;
}

export const PROVIDER_META: Record<string, ProviderBlurb> = {
  opencode_zen: {
    billing: "Pay-as-you-go per token plus a rotating free tier (this observatory benchmarks the free tier).",
    cadence: "~60 min",
  },
  opencode_go: {
    billing: "$10/mo Go / $40/mo Go Plus subscription with per-model monthly dollar limits (20% per 5h, 50% per week, 100% per month).",
    cadence: "~30 min (priciest ~6h)",
  },
  ollama: {
    billing: "Free tier with starter models; paid plans add usage credits.",
    cadence: "~60 min",
  },
  ollama_pro: {
    billing: "Pro subscription with usage credits metered per token at model rates.",
    cadence: "~10 min",
  },
  openrouter: {
    billing: "Pay-as-you-go per token; some models are free.",
    cadence: "provider LRU",
  },
};

export function providerMeta(name: string): ProviderBlurb {
  return (
    PROVIDER_META[name] ?? { billing: "See the provider docs for current billing.", cadence: "provider LRU" }
  );
}
