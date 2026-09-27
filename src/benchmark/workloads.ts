import type { BenchmarkDefinition, BenchmarkType } from "../types";

// Single deterministic prompt per spec s6 — same prompt for all models.
// Coding exercises both reasoning (algorithm) and long-form decode, giving
// the TPS/TTFT signal that short probes and summaries cannot.
export const WORKLOADS: Record<BenchmarkType, BenchmarkDefinition> = {
  coding: {
    type: "coding",
    prompt:
      "Implement a Python function solve(nums, target) that returns indices of two numbers adding to target. Explain complexity and provide working code with a test case. Keep output under 400 tokens.",
    // Floor 4092: thinking models burn budget on reasoning before answering;
    // headroom prevents finish_reason=length truncation polluting TPS.
    // Timeout 300s covers a full budget at ~13.6 TPS; slower records TIMEOUT.
    max_tokens: 4092,
    timeout_ms: 300000,
    // Nucleus sampling 0.95 (2026-09-27): the no-truncation default (top_p=1)
    // lets tail tokens through on several free gateways and produced ragged
    // completions; 0.95 is accepted by every OpenAI-compatible provider in
    // the registry and matches the playground default. Kept in the workload
    // (not left to provider defaults) so cron and playground measure the
    // same sampling conditions.
    top_p: 0.95,
  },
};

export function getWorkload(type: BenchmarkType): BenchmarkDefinition {
  return WORKLOADS[type];
}

export function allWorkloads(): BenchmarkDefinition[] {
  return Object.values(WORKLOADS);
}
