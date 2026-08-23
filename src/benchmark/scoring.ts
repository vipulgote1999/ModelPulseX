import { normalizeScores, overallScore } from "../utils/metrics";
import type { LeaderboardRow, ScoringProfile } from "../types";
import { SCORING_PROFILES } from "../types";

export function scoreLeaderboard(rows: LeaderboardRow[], profileId = "balanced"): LeaderboardRow[] {
  const profile: ScoringProfile =
    SCORING_PROFILES.find((p) => p.id === profileId) ?? SCORING_PROFILES[0]!;
  // Extract metrics across ACTIVE free rows only for normalization
  const activeRows = rows.filter((r) => r.active && r.free_status === "FREE");
  const tpsVals = activeRows.map((r) => r.tps_7d ?? r.tps_24h ?? r.tps_now);
  const ttftVals = activeRows.map((r) => r.ttft_7d ?? r.ttft_24h ?? r.ttft_now);
  const relVals = activeRows.map((r) => r.uptime_7d);
  // consistency as 1 - coefficient of variation approximated via (tps_now vs tps_7d closeness) — simple heuristic
  const consVals = activeRows.map((r) => {
    if (r.tps_7d != null && r.tps_now != null && r.tps_7d !== 0) {
      const ratio = Math.min(r.tps_now, r.tps_7d) / Math.max(r.tps_now, r.tps_7d);
      return ratio; // 0..1 closer to 1 means consistent
    }
    return 0.5;
  });

  const tpsNorm = normalizeScores(tpsVals, false);
  const ttftNorm = normalizeScores(ttftVals, true);
  const relNorm = normalizeScores(relVals, false);
  const consNorm = normalizeScores(consVals, false);

  // map back via activeRows index
  const idxMap = new Map<number, number>();
  activeRows.forEach((r, i) => idxMap.set(r.model_id, i));

  return rows.map((r) => {
    if (!r.active || r.free_status !== "FREE") return { ...r, overall_score: null };
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
  const fastestNow = [...active].filter((r) => r.tps_now != null).sort((a, b) => (b.tps_now ?? -1) - (a.tps_now ?? -1))[0] ?? null;
  const lowestTtft = [...active].filter((r) => r.ttft_now != null).sort((a, b) => (a.ttft_now ?? Infinity) - (b.ttft_now ?? Infinity))[0] ?? null;
  const mostReliable = [...active].filter((r) => r.uptime_7d != null).sort((a, b) => (b.uptime_7d ?? -1) - (a.uptime_7d ?? -1))[0] ?? null;
  // best coding would be leaderboard filtered by benchmark=coding; if not available fallback to most recent
  const bestCoding = active[0] ?? null;
  const bestConsistency = [...active].sort((a, b) => {
    const aC = a.tps_7d && a.tps_now ? Math.min(a.tps_now!, a.tps_7d!) / Math.max(a.tps_now!, a.tps_7d!) : 0;
    const bC = b.tps_7d && b.tps_now ? Math.min(b.tps_now!, b.tps_7d!) / Math.max(b.tps_now!, b.tps_7d!) : 0;
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
