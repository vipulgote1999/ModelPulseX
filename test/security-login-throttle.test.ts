/** SEC-004: the cross-isolate login throttle.
 *
 *  The bug: the 5-attempts/15-min login limit lived only in a module-level Map
 *  inside a Worker isolate. Isolates are ephemeral and per-colo, so an attacker
 *  spreading requests across PoPs got effectively unlimited attempts. The
 *  `login_attempts` table existed since migration 0010 and was pruned by
 *  retention cleanup, but nothing ever wrote to or read from it.
 *
 *  These tests pin the decision logic directly (no D1 needed) and then check
 *  the D1 integration, including the two failure modes that matter: a missing
 *  table must not lock everyone out, and a successful login must clear the
 *  counter.
 */
import { describe, expect, it } from "vitest";
import {
  clearLoginAttempts,
  decideThrottle,
  readLoginAttempt,
  recordLoginAttempt,
} from "../src/db/login-throttle";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

/** In-memory D1 stub for login_attempts: SELECT returns the stored row, the
 *  upsert stores into the map. */
function loginDb(initial: Record<string, { attempts: number; first: string; blocked?: string | null }> = {}) {
  const rows = new Map<string, { attempts: number; first_attempt_at: string; blocked_until: string | null }>();
  for (const [ip, v] of Object.entries(initial)) {
    rows.set(ip, { attempts: v.attempts, first_attempt_at: v.first, blocked_until: v.blocked ?? null });
  }
  const sql: string[] = [];
  const db = {
    sql,
    prepare(stmt: string) {
      sql.push(stmt);
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => {
              const row = rows.get(String(args[0]));
              return row
                ? {
                    attempts: row.attempts,
                    first_attempt_at: row.first_attempt_at,
                    blocked_until: row.blocked_until,
                  }
                : null;
            },
            run: async () => {
              if (/INSERT INTO login_attempts/i.test(stmt)) {
                const [ip, attempts, first, , blocked] = args as [
                  string, number, string, string, string | null,
                ];
                rows.set(ip, {
                  attempts,
                  first_attempt_at: first,
                  blocked_until: blocked,
                });
              } else if (/DELETE FROM login_attempts/i.test(stmt)) {
                rows.delete(String(args[0]));
              }
              return { meta: { changes: 1 } };
            },
            all: async () => ({ results: [] }),
          };
        },
        first: async () => null,
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
      };
    },
    batch: async () => [],
  };
  return Object.assign(db, { rows, sql });
}

describe("decideThrottle (pure)", () => {
  it("allows when under the cap", () => {
    expect(decideThrottle(3, NOW - MIN, null, NOW).blocked).toBe(false);
  });

  it("blocks once an active block_until is in the future", () => {
    const d = decideThrottle(9, NOW - 10 * MIN, NOW + 5 * MIN, NOW);
    expect(d.blocked).toBe(true);
    expect(d.retryAfter).toBeGreaterThan(0);
    expect(d.retryAfter).toBeLessThanOrEqual(5 * 60);
  });

  it("allows again once the block has expired", () => {
    expect(decideThrottle(9, NOW - 30 * MIN, NOW - MIN, NOW).blocked).toBe(false);
  });

  it("blocks on the over-cap attempt even without a stored block", () => {
    // Defensive: if a row somehow has no blocked_until but is over the cap,
    // the window that the first attempt opened is still the authority.
    const d = decideThrottle(6, NOW - 2 * MIN, null, NOW);
    expect(d.blocked).toBe(true);
    expect(d.retryAfter).toBeGreaterThan(0);
  });

  it("does not block an over-cap row whose window has also expired", () => {
    expect(decideThrottle(6, NOW - 20 * MIN, null, NOW).blocked).toBe(false);
  });
});

describe("recordLoginAttempt (D1 integration)", () => {
  it("counts attempts and trips the block past the cap", async () => {
    const db = loginDb();
    const ip = "203.0.113.9";
    // 5 attempts allowed.
    for (let i = 1; i <= 5; i++) {
      const d = await recordLoginAttempt(db as never, ip, NOW);
      expect(d.blocked, `attempt ${i} should be allowed`).toBe(false);
    }
    // The 6th trips it.
    const sixth = await recordLoginAttempt(db as never, ip, NOW);
    expect(sixth.blocked).toBe(true);
    expect(sixth.retryAfter).toBeGreaterThan(0);
  });

  it("resets the count when the window has expired", async () => {
    const db = loginDb();
    const ip = "203.0.113.10";
    for (let i = 0; i < 5; i++) await recordLoginAttempt(db as never, ip, NOW);
    expect(db.rows.get(ip)!.attempts).toBe(5);
    // 16 minutes later the window is gone: the next attempt starts at 1.
    const later = await recordLoginAttempt(db as never, ip, NOW + 16 * MIN);
    expect(later.blocked).toBe(false);
    expect(db.rows.get(ip)!.attempts).toBe(1);
  });

  it("keeps separate counters per IP", async () => {
    const db = loginDb();
    for (let i = 0; i < 7; i++) await recordLoginAttempt(db as never, "1.1.1.1", NOW);
    const other = await recordLoginAttempt(db as never, "2.2.2.2", NOW);
    expect(other.blocked).toBe(false);
    expect(db.rows.get("2.2.2.2")!.attempts).toBe(1);
  });

  it("uses an upsert keyed on ip (no read-then-write race)", async () => {
    const db = loginDb();
    await recordLoginAttempt(db as never, "3.3.3.3", NOW);
    expect(db.sql.some((s) => /ON CONFLICT\(ip\) DO UPDATE/i.test(s))).toBe(true);
  });

  it("does not throw when the table is missing (pre-migration)", async () => {
    // A DB failure must fail OPEN to the in-memory limiter, never to blocking
    // every login, and never by throwing out of the route.
    const broken = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1_ERROR: no such table: login_attempts");
          },
          run: async () => {
            throw new Error("D1_ERROR: no such table: login_attempts");
          },
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const d = await recordLoginAttempt(broken as never, "4.4.4.4", NOW);
    expect(d.blocked).toBe(false);
    expect(await readLoginAttempt(broken as never, "4.4.4.4")).toBeNull();
  });
});

describe("clearLoginAttempts", () => {
  it("removes the row so a legitimate user is not left throttled", async () => {
    const db = loginDb();
    const ip = "5.5.5.5";
    for (let i = 0; i < 4; i++) await recordLoginAttempt(db as never, ip, NOW);
    expect(db.rows.get(ip)!.attempts).toBe(4);
    await clearLoginAttempts(db as never, ip);
    expect(db.rows.has(ip)).toBe(false);
    const after = await recordLoginAttempt(db as never, ip, NOW);
    expect(after.blocked).toBe(false);
    expect(after.attempts).toBe(1);
  });

  it("never throws when the table is missing", async () => {
    const broken = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("no such table");
          },
        }),
      }),
    };
    await expect(clearLoginAttempts(broken as never, "6.6.6.6")).resolves.toBeUndefined();
  });
});
