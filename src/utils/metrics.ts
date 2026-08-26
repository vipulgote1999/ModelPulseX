/** Pure metric math — no Cloudflare imports, fully unit-testable. */

// TTFT = first_token_at - started_at (ms)
export function computeTTFT(startedAtMs: number, firstTokenAtMs: number | null): number | null {
  if (firstTokenAtMs == null) return null;
  const d = firstTokenAtMs - startedAtMs;
  return d >= 0 ? d : null;
}

// generation = completed - first_token
export function computeGenerationMs(firstTokenAtMs: number | null, completedAtMs: number | null): number | null {
  if (firstTokenAtMs == null || completedAtMs == null) return null;
  const d = completedAtMs - firstTokenAtMs;
  if (d < 0) return null;
  // clamp to 1ms when clock granularity yields 0 (real generation >0, but same-ms tick would otherwise null TPS)
  return d === 0 ? 1 : d;
}

// TPS = outputTokens / generation_seconds; MUST use generation_ms not total duration
export function computeTPS(outputTokens: number | null, generationMs: number | null): number | null {
  if (outputTokens == null || generationMs == null || generationMs <= 0) return null;
  return outputTokens / (generationMs / 1000);
}

// percentile helper exact (sort)
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, Math.min(idx, s.length - 1))] ?? null;
}

/** Minimum samples before a windowed metric is displayed. Below threshold we show "insufficient
 *  data" instead of a number — prevents 1-2-sample spikes from ranking #1 (industry practice:
 *  Artificial Analysis uses sustained medians over trailing windows). */
export const MIN_SAMPLES = { w1h: 2, w24h: 3, w7d: 5 } as const;

/** Parse SQLite GROUP_CONCAT numeric output ("12.5,,30,0") into clean positive numbers. */
export function parseConcatNumbers(gc: string | null | undefined): number[] {
  return (gc ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
}

// quick uptime from success/total
export function uptimeRate(success: number, total: number): number | null {
  if (total === 0) return null;
  return success / total;
}

// heuristic token estimation char/4 when provider usage missing; flagged as heuristic
export function estimateTokensHeuristic(text: string | null | undefined): number | null {
  if (!text) return null;
  return Math.ceil(text.length / 4);
}

// normalize across active models for scoring 0..1 (higher is better; for ttft lower is better so invert)
export function normalizeScores(values: (number | null)[], invert = false): (number | null)[] {
  const valid = values.filter((v): v is number => v != null);
  if (valid.length === 0) return values.map(() => null);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  if (max === min) return values.map((v) => (v == null ? null : 1));
  return values.map((v) => {
    if (v == null) return null;
    const n = (v - min) / (max - min);
    return invert ? 1 - n : n;
  });
}

export function overallScore(
  tpsScore: number | null,
  ttftScore: number | null,
  reliabilityScore: number | null,
  consistencyScore: number | null,
  weights: { tps: number; ttft: number; reliability: number; consistency: number } = {
    tps: 0.4,
    ttft: 0.25,
    reliability: 0.25,
    consistency: 0.1,
  },
): number | null {
  const vals = [tpsScore, ttftScore, reliabilityScore, consistencyScore];
  if (vals.some((v) => v == null)) {
    // if missing, use 0 for missing so score still computable if at least one present; but require at least 2
    const present = vals.filter((v) => v != null).length;
    if (present < 2) return null;
  }
  const tps = tpsScore ?? 0;
  const ttft = ttftScore ?? 0;
  const rel = reliabilityScore ?? 0;
  const cons = consistencyScore ?? 0;
  return weights.tps * tps + weights.ttft * ttft + weights.reliability * rel + weights.consistency * cons;
}
