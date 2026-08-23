import type { BenchmarkDefinition, BenchmarkType } from "../types";

// Deterministic prompts per spec s6 — same prompt for all models per benchmark_type
export const WORKLOADS: Record<BenchmarkType, BenchmarkDefinition> = {
  short: {
    type: "short",
    prompt: "Return exactly: PONG",
    max_tokens: 16,
    timeout_ms: 15000,
  },
  medium: {
    type: "medium",
    prompt:
      "Write a concise 180-220 word summary of why observability matters for LLM APIs. Plain text only.",
    max_tokens: 300,
    timeout_ms: 30000,
  },
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
