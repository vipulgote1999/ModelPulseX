import { e2eSpeed, normalizeScores, overallScore } from "../utils/metrics";
import type { LeaderboardRow, ScoringProfile } from "../types";
import { SCORING_PROFILES } from "../types";

export function scoreLeaderboard(rows: LeaderboardRow[], profileId = "balanced"): LeaderboardRow[] {
  const profile: ScoringProfile =
    SCORING_PROFILES.find((p) => p.id === profileId) ?? SCORING_PROFILES[0]!;
  // Extract metrics across ACTIVE free rows only for normalization
  const activeRows = rows.filter((r) => r.active && r.free_status === "FREE");
  const tpsVals = activeRows.map((r) => e2eSpeed(r));
  const ttftVals = activeRows.map((r) => r.ttft_7d ?? r.ttft_24h ?? r.ttft_now);
  const relVals = activeRows.map((r) => r.uptime_7d);
  // Consistency needs both ends of the comparison: without e2e_now AND
  // e2e_7d there is no closeness to measure. Batch-3: the old 0.5 fallback
  // fed every unevidenced row the same value, and normalizeScores maps a
  // constant input to a perfect 1.0 — invented consistency that outranked
  // measured rows. Decode TPS is diagnostic and never scores.
  const consVals = activeRows.map((r) => {
    if (r.e2e_tps_7d != null && r.e2e_tps_now != null && r.e2e_tps_7d !== 0) {
      const ratio = Math.min(r.e2e_tps_now, r.e2e_tps_7d) / Math.max(r.e2e_tps_now, r.e2e_tps_7d);
      return ratio; // 0..1 closer to 1 means consistent
    }
    return null;
  });

  const tpsNorm = normalizeScores(tpsVals, false);
  const ttftNorm = normalizeScores(ttftVals, true);
  const relNorm = normalizeScores(relVals, false);
  const consNorm = normalizeScores(consVals, false);

  // map back via activeRows index
  const idxMap = new Map<number, number>();
  activeRows.forEach((r, i) => idxMap.set(r.model_id, i));

  return rows.map((r) => {
    // Unmeasured rows (overlay miss → explicit null status) carry no latest-run
    // evidence: scoring them with windowed medians alone produced ranked
    // score-5/67 ghosts (loop-8: null-status rows ranked on uptime residue).
    // Null the score; the rank sink already lists them last. `=== null` (not
    // `==`) so legacy rows without a status field keep samples-only behavior.
    // Throughput gate: a row with no end-to-end TPS in any window has no
    // comparable speed signal. Decode is diagnostic only — 2026-09-24 prod
    // ranked 7 zero-TPS failure rows 52–58 on uptime residue (all score 5.0),
    // and block-delivery models would win on decode alone. Rank means
    // comparable evidence; score null instead.
    if (!r.active || r.free_status !== "FREE" || r.status === null) return { ...r, overall_score: null };
    if (e2eSpeed(r) == null) return { ...r, overall_score: null };
    const idx = idxMap.get(r.model_id)!;
    const sc = overallScore(tpsNorm[idx]!, ttftNorm[idx]!, relNorm[idx]!, consNorm[idx]!, profile.weights);
    return { ...r, overall_score: sc != null ? Math.round(sc * 1000) / 10 : null }; // 0..100 one decimal
  });
}

export function recommendationCards(rows: LeaderboardRow[]): Record<string, LeaderboardRow | null> {
  const active = rows.filter((r) => r.active && r.free_status === "FREE");
  if (active.length === 0) {
    return { best_overall: null, fastest_now: null, lowest_ttft: null, most_reliable: null, best_coding: null, best_consistency: null };
  }
  // assume coding rows are derived from benchmark_type=coding leaderboard elsewhere; here we use same set
  const scored = scoreLeaderboard(rows, "balanced");
  const bestOverall = [...scored].filter((r) => r.overall_score != null).sort((a, b) => (b.overall_score ?? -1) - (a.overall_score ?? -1))[0] ?? null;
  const fastestNow = [...active].filter((r) => r.e2e_tps_now != null).sort((a, b) => (b.e2e_tps_now ?? -1) - (a.e2e_tps_now ?? -1))[0] ?? null;
  const lowestTtft = [...active].filter((r) => r.ttft_now != null).sort((a, b) => (a.ttft_now ?? Infinity) - (b.ttft_now ?? Infinity))[0] ?? null;
  const mostReliable = [...active].filter((r) => r.uptime_7d != null).sort((a, b) => (b.uptime_7d ?? -1) - (a.uptime_7d ?? -1))[0] ?? null;
  // Single-coding observatory: every row is already coding-filtered upstream,
  // so best_coding == best_overall. The old active[0] fallback crowned
  // whatever display_name sorted first — an arbitrary pick mislabeled as a
  // coding winner. Batch-3 removes the fallback; null when nothing scored.
  const bestCoding = bestOverall;
  const bestConsistency = [...active].sort((a, b) => {
    const aC = a.e2e_tps_7d && a.e2e_tps_now ? Math.min(a.e2e_tps_now!, a.e2e_tps_7d!) / Math.max(a.e2e_tps_now!, a.e2e_tps_7d!) : 0;
    const bC = b.e2e_tps_7d && b.e2e_tps_now ? Math.min(b.e2e_tps_now!, b.e2e_tps_7d!) / Math.max(b.e2e_tps_now!, b.e2e_tps_7d!) : 0;
    return bC - aC;
  })[0] ?? null;
  return {
    best_overall: bestOverall,
    fastest_now: fastestNow,
    lowest_ttft: lowestTtft,
    most_reliable: mostReliable,
    best_coding: bestCoding,
    best_consistency: bestConsistency,
  };
}
