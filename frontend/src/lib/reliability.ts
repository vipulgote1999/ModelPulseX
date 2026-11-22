/** Availability summary for the reliability timeline.
 *
 *  BUG-2026-11-22: the timeline painted a bar green at success_rate >= 0.5 and
 *  the legend said "hour fully successful (≥50% success)", but the percentage
 *  beside it counted only success_rate >= 1 — a mostly-green week could read
 *  "5% hours fully up". One threshold drives both the bars and the percentage.
 */
export const HOUR_UP_THRESHOLD = 0.5;

export function hoursUpPercent(
  points: Array<{ success_rate: number | null }>,
): number | null {
  if (points.length === 0) return null;
  const up = points.filter(
    (p) => (p.success_rate ?? 0) >= HOUR_UP_THRESHOLD,
  ).length;
  return Math.round((up / points.length) * 100);
}
