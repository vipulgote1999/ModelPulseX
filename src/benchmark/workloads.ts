import type { BenchmarkDefinition, BenchmarkType } from "../types";

// Single deterministic prompt per spec s6 — same prompt for all models.
// Coding exercises both reasoning (algorithm) and long-form decode, giving
// the TPS/TTFT signal that short probes and summaries cannot.
export const WORKLOADS: Record<BenchmarkType, BenchmarkDefinition> = {
  coding: {
    type: "coding",
    prompt:
      "Implement a Python function solve(nums, target) that returns indices of two numbers adding to target. Explain complexity and provide working code with a test case. Keep output under 400 tokens.",
    max_tokens: 600,
    timeout_ms: 45000,
  },
};

export function getWorkload(type: BenchmarkType): BenchmarkDefinition {
  return WORKLOADS[type];
}

export function allWorkloads(): BenchmarkDefinition[] {
  return Object.values(WORKLOADS);
}
