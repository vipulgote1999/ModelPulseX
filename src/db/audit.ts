/** Append-only admin audit trail (`audit_log`, migration `0010_security.sql`).
 *
 *  Security properties:
 *  - **never stores a credential.** The actor is a short SHA-256 fingerprint of the
 *    presented bearer token, so rows prove "same actor" without holding a secret —
 *    the table cannot become a token dump.
 *  - **never throws.** A missing table (deploy before migration) must not break
 *    admin routes, matching the tolerant writers in `src/db/health.ts`.
 *  - **caller-supplied details only**, length-capped: request bodies are never
 *    serialized, so admin payloads (which may carry model ids) stay bounded.
 */

const MAX_IP = 45;
const MAX_UA = 200;
const MAX_TARGET = 200;

/** Short stable fingerprint of a secret. 8 bytes hex = 16 chars: collision-safe
 *  for actor distinction, useless for recovering the input. */
export async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface AuditEntry {
  /** Verb + path, e.g. `post /api/admin/benchmark`. */
  action: string;
  /** Raw presented credential — fingerprinted here, never stored raw. */
  actor?: string;
  ip?: string | null;
  userAgent?: string | null;
  target?: string | null;
  /** Small, explicit, sanitized facts (status codes, counts). */
  details?: Record<string, string | number | boolean | null>;
}

/** Write one audit row. Returns whether the row landed; never throws. */
export async function recordAudit(
  db: D1Database,
  entry: AuditEntry,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (ts, action, actor_fingerprint, ip, user_agent, target, details)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(
        new Date().toISOString(),
        entry.action,
        entry.actor ? await fingerprint(entry.actor) : "anonymous",
        entry.ip ? entry.ip.slice(0, MAX_IP) : null,
        entry.userAgent ? entry.userAgent.slice(0, MAX_UA) : null,
        entry.target ? entry.target.slice(0, MAX_TARGET) : null,
        entry.details ? JSON.stringify(entry.details) : null,
      )
      .run();
    return true;
  } catch (e) {
    // A missing audit row is a security-relevant failure, not a warning.
    console.error("audit write failed", e);
    return false;
  }
}
