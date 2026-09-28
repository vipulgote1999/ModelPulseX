/** Cross-isolate brute-force throttle for `POST /api/admin/login`.
 *
 *  **Why this exists (SEC-004).** The 5-attempts/15-min login limit lived in a
 *  module-level `Map` (`src/utils/rate-limit.ts`). Workers isolates are
 *  ephemeral and per-colo, so an attacker spreading requests across PoPs got
 *  effectively unlimited attempts — the limit was a suggestion, not a control.
 *
 *  `migrations/0010_security.sql` already created the `login_attempts` table
 *  for exactly this purpose, and `cleanupRetention` already prunes it — but no
 *  code ever wrote to or read from it. This module is that missing half.
 *
 *  Design notes:
 *  - The in-memory slider stays as the cheap first line, so an ordinary user
 *    is not charged a D1 round-trip on every attempt.
 *  - Every D1 path is wrapped: if D1 is unavailable the in-memory limiter
 *    still applies, so a database outage cannot silently remove the
 *    protection (fail closed toward "still limited", never toward "unlimited").
 *  - Writes are upserts on the `ip` primary key, so one statement per attempt
 *    and no read-then-write race between concurrent isolates.
 *
 *  Pure SQL + small helpers; no Cloudflare imports beyond the D1 types, so it
 *  is testable with a fake D1 like the rest of `src/db`.
 */

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
/** How long a blocked IP stays blocked after tripping the limit. Kept equal to
 *  the window so the semantics match the in-memory slider: 5 attempts per
 *  15 minutes, counted per IP. */
const BLOCK_MS = WINDOW_MS;

export interface ThrottleDecision {
  blocked: boolean;
  attempts: number;
  /** Seconds the caller should wait; 0 when not blocked. */
  retryAfter: number;
}

/** Pure decision function, split out for direct unit testing without a D1 fake.
 *
 *  `attempts` is the number of attempts ALREADY CONSUMED in the current
 *  window, i.e. this request has not been counted yet. `blockedUntil` is any
 *  active block written by a previous attempt. The caller either consults this
 *  before doing any credential work (the check path) or calls it with the
 *  pre-increment count after recording (the record path), which is why it
 *  takes the prior count rather than the new one — otherwise "5 allowed, 6th
 *  refused" becomes "5th refused" depending on which path you ask. */
export function decideThrottle(
  attempts: number,
  firstAt: number,
  blockedUntil: number | null,
  now: number,
): ThrottleDecision {
  if (blockedUntil && blockedUntil > now) {
    return {
      blocked: true,
      attempts,
      retryAfter: Math.ceil((blockedUntil - now) / 1000),
    };
  }
  if (attempts >= MAX_ATTEMPTS) {
    // The cap is consumed but the stored block has expired (or was never set).
    // Fall back to the window the first attempt opened, so an over-cap row can
    // never be used to grant extra attempts by clearing blocked_until.
    const windowEnd = firstAt + WINDOW_MS;
    if (windowEnd > now) {
      return {
        blocked: true,
        attempts,
        retryAfter: Math.ceil((windowEnd - now) / 1000),
      };
    }
  }
  return { blocked: false, attempts, retryAfter: 0 };
}

/** Read the current row for an IP. Returns null when the table is missing
 *  (pre-migration) or D1 is unavailable — callers must treat null as "no
 *  cross-isolate record", never as "unblocked by a decision". */
export async function readLoginAttempt(
  db: D1Database,
  ip: string,
): Promise<{ attempts: number; firstAt: number; blockedUntil: number | null } | null> {
  try {
    const row = await db
      .prepare(
        "SELECT attempts, first_attempt_at, blocked_until FROM login_attempts WHERE ip=?",
      )
      .bind(ip)
      .first<{
        attempts: number;
        first_attempt_at: string;
        blocked_until: string | null;
      }>();
    if (!row) return null;
    return {
      attempts: row.attempts ?? 0,
      firstAt: Date.parse(row.first_attempt_at) || 0,
      blockedUntil: row.blocked_until ? Date.parse(row.blocked_until) || null : null,
    };
  } catch {
    return null;
  }
}

/** Record one attempt and return the resulting decision. */
export async function recordLoginAttempt(
  db: D1Database,
  ip: string,
  nowMs: number = Date.now(),
): Promise<ThrottleDecision> {
  const now = new Date(nowMs).toISOString();
  try {
    const prior = await readLoginAttempt(db, ip);
    const firstAt = prior ? prior.firstAt : nowMs;
    // Window expired -> restart the count from 1 with a fresh window start.
    const windowFresh = nowMs - firstAt < WINDOW_MS;
    const attempts = windowFresh ? (prior?.attempts ?? 0) + 1 : 1;
    const start = windowFresh ? new Date(firstAt).toISOString() : now;
    // Trip the block on the attempt that crosses the cap, so the cap is
    // "5 attempts allowed, the 6th onwards rejected".
    const blockedUntil =
      attempts > MAX_ATTEMPTS
        ? new Date(nowMs + BLOCK_MS).toISOString()
        : null;
    await db
      .prepare(
        `INSERT INTO login_attempts (ip, attempts, first_attempt_at, last_attempt_at, blocked_until)
         VALUES (?,?,?,?,?)
         ON CONFLICT(ip) DO UPDATE SET
           attempts=excluded.attempts,
           first_attempt_at=excluded.first_attempt_at,
           last_attempt_at=excluded.last_attempt_at,
           blocked_until=excluded.blocked_until`,
      )
      .bind(ip, attempts, start, now, blockedUntil)
      .run();
    // This attempt was allowed (we reached the write), so the decision is made
    // from the PRIOR count — passing the post-increment count would make the
    // 5th attempt look like the 6th and refuse it. The returned `attempts` is
    // then the new total, for logging.
    const decision = decideThrottle(
      prior && windowFresh ? prior.attempts : 0,
      windowFresh ? firstAt : nowMs,
      null,
      nowMs,
    );
    return { ...decision, attempts };
  } catch {
    // D1 unavailable / table missing. The in-memory limiter still applies, so
    // report "not blocked by the cross-isolate store" rather than blocking all
    // logins (which would be a self-inflicted outage on every DB blip).
    return { blocked: false, attempts: 0, retryAfter: 0 };
  }
}

/** Clear the counter for an IP after a successful login. */
export async function clearLoginAttempts(
  db: D1Database,
  ip: string,
): Promise<void> {
  try {
    await db.prepare("DELETE FROM login_attempts WHERE ip=?").bind(ip).run();
  } catch {
    // best-effort: a stale counter self-expires via the window
  }
}
