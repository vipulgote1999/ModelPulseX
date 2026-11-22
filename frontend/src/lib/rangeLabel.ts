/** Human labels for the leaderboard range selector. Charts render hourly (or
 *  10-minute) aggregates; the window title must follow the selected range
 *  instead of always claiming "7-day". */
const RANGE_LABELS: Record<string, string> = {
  "1h": "1-hour",
  "24h": "24-hour",
  "3d": "3-day",
  "7d": "7-day",
};

export function rangeLabel(range: string | undefined): string {
  return (range != null && RANGE_LABELS[range]) || "7-day";
}

export function bucketLabel(range: string | undefined): string {
  return range === "1h" ? "10m buckets" : "hourly aggregates";
}
