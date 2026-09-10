# BUG-2026-09-10-audit-log-gap: security report claimed admin auditing that did not exist

GitHub: #20. Status: verified then fixed (writer implemented + report corrected).

## Claim under test

`SECURITY_AUDIT_REPORT.md` claimed `src/utils/security.ts:auditLog` writes an `audit_log`
table and that all admin actions are audited (report rows 9, and lines 155/159).

## Verification (before the fix)

- `src/utils/security.ts` exports `timingSafeEqual`, `isStrongToken`,
  `sanitizeSearchQuery`, `escapeLikePattern`, `sanitizeErrorMessage`,
  `validateCorsConfig` — **no `auditLog`**.
- Repo-wide grep for `audit_log` / `login_attempts`: only the table DDL
  (`migrations/0010_security.sql`) and a retention `DELETE FROM login_attempts`
  (`src/db/queries.ts:674`). **No writer existed** for either table.

Verdict: the report was wrong **and** the capability was genuinely missing — the table was
provisioned, indexed, pruned and documented, but never written.

## Fix (decision: implement, not merely document)

The infrastructure was 80% present (table + indexes + retention + report claims), so the
cheap correct outcome is to make the claim true:

1. **`src/db/audit.ts`** — `recordAudit(db, entry)` + `fingerprint(secret)`.
   - actor stored as a 16-char SHA-256 fingerprint, **never the raw credential**;
   - `ip` capped at 45, `user_agent` at 200, `target` at 200, `details` caller-supplied
     JSON only (never request bodies);
   - tolerant of a missing table (returns `false`, logs `console.error`) — a
     pre-migration deploy must not break admin routes; audit failure is an error, not a warn.
2. **`src/api/routes.ts`** — one middleware on `/api/admin/*` audits every admin request
   (main, models and maintenance routers) — allow **and** deny, since denials are the
   brute-force signal. Registered **after** the rate limiter on purpose: a 429 never
   reaches it, so an attacker hammering the endpoint cannot turn each refused request into
   a D1 write. Trade-off recorded in the code comment: 429s are not audited.
3. **Report corrected** where it still misdescribed reality, and the `login_attempts`
   gap stated honestly (per-isolate in-memory limiter only — 5 attempts/15 min via
   `src/utils/rate-limit.ts`; cross-edge bucket provisioned but unwired, tracked as #24).

## Acceptance Criteria

- [x] Verified: no writer existed for `audit_log` (and none for `login_attempts`)
- [x] Admin actions ARE audited — `test/audit.test.ts` proves a denied call, an authorized
      call, and that **both** the models and maintenance routers are covered
- [x] The raw token never reaches the table (asserted on captured binds)
- [x] Report claims replaced with the implemented reality + the remaining gap named

## Verification

- `npx vitest run test/audit.test.ts` → 7 passed (fingerprint, capping, missing-table
  tolerance, 401 path, authorized path, cross-router coverage)
- `tsc --noEmit` clean, `eslint .` clean
