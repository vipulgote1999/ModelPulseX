/** Provider-agnostic dead-model auto-disable — pure, Cloudflare-free.
 *
 *  Failures are counted over a trailing 24h window per model (not consecutive
 *  streaks), so flaky-but-recovering models survive while models that burn a
 *  full probe (TIMEOUT) or hard-fail every cycle get disabled fast.
 *  Recovery is manual via the admin toggle (which also clears the cooldown).
 */
export const AUTO_DISABLE_DAILY_MAX_DEFAULT = 10;
/** Gone-model signal (404 / "not supported" / "model is unavailable" …) needs
 *  only this many hits in 24h — the model is gone, not flaky. */
export const GONE_MODEL_MIN_COUNT = 2;
/** Escalating model cooldown never exceeds this (dead models probe ≤1/day). */
export const MODEL_COOLDOWN_CAP_MS = 24 * 60 * 60 * 1000;

const GONE_MODEL_PATTERNS = [
  /not supported/i,
  /model is unavailable/i,
  /\bnot found\b/i,
  /no such model/i,
  /unknown model/i,
  /does not exist/i,
  /\bremoved\b/i,
  /\bretired\b/i,
  /decommissioned/i,
  /\bdeleted\b/i,
];

export function isGoneModelErrorText(
  err: string | null | undefined,
): boolean {
  if (!err) return false;
  return GONE_MODEL_PATTERNS.some((re) => re.test(err));
}

export interface DayFailureRow {
  status: string;
  error_type?: string | null;
  http_status?: number | null;
}

/** Count failures + gone-model hits in a trailing-24h slice (SUCCESS ignored). */
export function countDayFailures(rows: DayFailureRow[]): {
  failures: number;
  goneHits: number;
} {
  let failures = 0;
  let goneHits = 0;
  for (const r of rows) {
    if (r.status === "SUCCESS") continue;
    failures++;
    if (
      r.status === "MODEL_UNAVAILABLE" ||
      r.http_status === 404 ||
      isGoneModelErrorText(r.error_type)
    )
      goneHits++;
  }
  return { failures, goneHits };
}

export function shouldAutoDisable(
  failures: number,
  goneHits: number,
  dailyMax: number,
): { disable: boolean; reason: string | null } {
  if (goneHits >= GONE_MODEL_MIN_COUNT)
    return {
      disable: true,
      reason: `AUTO_DISABLED gone-model x${goneHits}/24h`,
    };
  if (failures >= dailyMax)
    return {
      disable: true,
      reason: `AUTO_DISABLED ${failures} failures/24h (max ${dailyMax})`,
    };
  return { disable: false, reason: null };
}

/** Doubling backoff on the 24h failure count so repeat offenders probe rarely. */
export function escalatedModelCooldownMs(
  baseMs: number,
  failures24h: number,
  capMs: number = MODEL_COOLDOWN_CAP_MS,
): number {
  if (failures24h <= 1) return Math.min(baseMs, capMs);
  const exp = Math.min(failures24h - 1, 20);
  return Math.min(baseMs * 2 ** exp, capMs);
}
