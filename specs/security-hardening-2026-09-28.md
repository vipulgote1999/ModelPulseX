# Security Hardening — 2026-09-28 (SEC-002)

**Status:** approved for implementation
**Supersedes claims in:** `SECURITY_AUDIT_REPORT.md` (2026-08-28) — that report's
"Hardening Checklist" contains three verified-false claims, corrected below.
**Scope:** credential protection, admin auth, data-visibility gates, unauthenticated
resource exhaustion, gate hygiene.

---

## 0. Corrections to the previous audit

The 2026-08-28 report scored 93/100 and marked all boxes green. Re-verified against
the code on 2026-09-28, three claims do not hold:

| Prior claim | Reality | Evidence |
| --- | --- | --- |
| "`.env`/`.dev.vars` sanitized → placeholders" | **False.** Four files hold live secrets | `.env`, `.dev.vars`, `.env.backup-2026-08-28`, `.dev.vars.backup-2026-08-28` |
| "0 vulnerabilities, gates GREEN" | **Partly false.** `npm run lint` is red (23 errors) | all 23 in untracked `videos/` dir, which is also not in `.gitignore` |
| "Login is rate-limited (5/15m per IP)" | **True but misleading.** Per-isolate in-memory only; `login_attempts` table has no writer | `migrations/0010_security.sql:19` creates it; grep shows only a prune in `src/db/queries.ts:671` |

Positive findings that survive re-verification and must not be regressed:
- **Git history is clean of real secrets.** `git log -S "sk-or-v1-"` matches only the
  audit report's prose and the scanner regex in `scripts/secret-scan.js:5-6`.
- **No SQL injection.** 17 interpolation sites traced; all are constants or generated
  `?,?,?` placeholders. `sort`/`profile`/`range` never reach SQL.
- **No unauthenticated admin route.** 11 of 12 admin routes call `isAdmin`; the 12th
  (`/api/admin/login`) is intentionally public. `isAdmin` fails closed without a token.
- **No XSS sink** in `frontend/src` or `src` — no `dangerouslySetInnerHTML`, no `eval`.
- **Production dependency audit is clean** (`npm audit --omit=dev` → 0). The 5 dev-tree
  findings (sharp/miniflare via wrangler, @vitest/mocker) have no forward fix without
  downgrading wrangler; CI already gates this correctly as advisory.

---

## 1. Blocking issue outside the code: the filesystem cannot hold secrets safely

`/media/vipul/Ext_drive1` is **exFAT** (`fmask=0022,dmask=0022`). exFAT has no Unix
permission model, so:

- `chmod 600` on the secret files is a **silent no-op** — verified: a throwaway file
  stayed `755` after `chmod 600`, while the same command on a tmpfs file yielded `600`.
- There are no POSIX ACLs either. Every file on this volume is world-readable to any
  process running as any local user, and to anything that reads the removable drive.
- `.env.backup-2026-08-28` contains a **`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`**.
  That token can deploy Worker code, read every Worker secret, and read/write D1.
  It has been sitting on a world-readable removable volume.

**Owner action required (not fixable in code):**

1. **Rotate `CLOUDFLARE_API_TOKEN`** in the Cloudflare dashboard. Highest priority.
2. Rotate every provider key present in those four files.
3. **Rotate `ADMIN_PASSWORD`.** The 9-character value `Test@1675` is written in plaintext
   in the committed `SECURITY_AUDIT_REPORT.md:60`, so it is in git history permanently
   and must be treated as public. (This spec redacts it from the report's live text;
   history still contains it — rotation is the only real fix.)
4. To get any real file-permission protection, either move the secret files off the exFAT
   volume, or remount it with `dmask=0077,fmask=0077` (requires root + unmount; not
   performed automatically because it affects the whole drive).

Code-side we still ship `.gitignore` coverage and the pre-commit scanner, both of which
already work regardless of filesystem.

---

## 2. SEC-001 — Admin token readable by any script (CRITICAL)

**Problem.** `frontend/src/pages/Admin.tsx:33,39,141,153` and
`frontend/src/components/CooldownPanel.tsx:6,15` persist the admin bearer token in
`localStorage`. Consequences: any XSS (none today, but CSP drift or a future dependency
would open one), any malicious browser extension, and any local process reading the
browser profile can read it. It never expires. Possession = full admin control
(read all data, toggle any model, force benchmarks, spend provider credits).

**Design.**

- `POST /api/admin/login` sets the token in a cookie:
  `mpx_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`
  `HttpOnly` removes it from JS reach entirely — the core fix.
  `SameSite=Strict` blocks the cookie on cross-site requests, which handles login-CSRF.
- **CSRF defence in depth.** A second, JS-readable cookie `mpx_csrf` holds a random
  value. Every state-changing `/api/admin/*` request must echo it in an `X-CSRF-Token`
  header. A cross-origin attacker can neither read the cookie nor set a custom header
  (that triggers a CORS preflight, which our origin allowlist fails). Auth is therefore
  required **and** unforgeable cross-site.
- **`Authorization: Bearer` stays supported** for `curl`/CI automation, which has no
  cookie jar. It is no longer *persisted* by any browser code, which was the actual risk.
- Frontend deletes every `localStorage` read/write of the token and drives auth off
  `credentials: "same-origin"` (default) plus the CSRF header.
- A `mpx_admin_token` value already sitting in a visitor's browser is purged on load so
  an upgrade revokes previously-persisted tokens.

**Tests.** `test/security-cookie-auth.test.ts` — cookie is set with HttpOnly/Secure/
SameSite=Strict; cookie satisfies `isAdmin`; missing/mismatched CSRF header is rejected
on POST; correct CSRF passes; bearer still works; login no longer returns the token in
the JSON body.

---

## 3. SEC-002 — Detail routes bypass the visibility gates (HIGH, data exposure)

**Problem.** The list routes deliberately hide PAID, inactive, admin-disabled, and
registry-blacklisted models (`src/api/models.ts:23-29`, `src/api/leaderboard.ts:151,351`).
The by-id routes apply **none** of those gates, so an unauthenticated caller can read
TPS / TTFT / uptime / pricing metadata / full history / incidents for any row in
`models` — including the "stealth" rows the snapshot code goes out of its way to evict
from the leaderboard. Routes: `models.ts:42`, `models.ts:66`, `models.ts:97`,
`models.ts:154`, and `compare.ts:22-57`.

**Design.** Extract the gate predicate already used by the list routes
(`freeHardFilterWhere` in `src/providers/registry.ts:350`) into one shared helper and
apply it to every public detail route. 404 when it does not match, so the response
shape is identical to a genuinely absent model and does not confirm existence. Admin
routes are unaffected and still see everything.

**Tests.** Paid / inactive / disabled / blacklisted ids 404 on
`/api/models/:id`, `/api/models/:id/history`, `/api/models/:id/incidents`, and are
excluded from `/api/compare`. FREE+active+enabled ids still return 200.

---

## 4. SEC-003 — Unauthenticated D1 write amplification (HIGH)

**Problem.** `src/api/routes.ts:115-127` inserts an `audit_log` row for **every**
`/api/admin/*` request, including requests with no credential that get a 401, and
including 404s for paths that do not exist. The only bound is a per-isolate in-memory
limiter (30/min), so a distributed client can drive unbounded writes against the D1
write quota.

**Design.** Keep the forensic signal, drop the noise. Audit a request when it either
(a) was authenticated, (b) presented a credential that failed, or (c) hit
`/api/admin/login` (audited explicitly, on both success and failure). Skip bare
unauthenticated probes with no credential — those are pure write amplification and
carry no signal a real brute-force attempt lacks. A real brute-forcer sends a password
to `/api/admin/login`, which is still fully audited.

---

## 5. SEC-004 — Cross-isolate brute force is not actually limited (HIGH)

**Problem.** The 5-attempts/15-min login limit lives in a module-level `Map` in
`src/utils/rate-limit.ts:16`. Workers isolates are ephemeral and per-colo, so an
attacker spreading requests across PoPs gets effectively unlimited attempts.
`migrations/0010_security.sql:19` already created the `login_attempts` table for exactly
this, but no code ever writes to it (only `src/db/queries.ts:671` prunes it).

**Design.** Implement the missing writer/reader. On each `/api/admin/login`:
upsert the IP's attempt row; if `attempts >= 5` within the window and `blocked_until`
is still in the future, reject before any credential comparison. Clear the counter on
success. The in-memory limiter stays as the cheap first line so a normal user is never
hit by a D1 round-trip. Every path degrades safely: if D1 is unavailable the in-memory
limiter still applies, so a DB outage cannot silently remove the protection.

---

## 6. SEC-005 — Auth accepts the token in ways that leak it (MEDIUM)

**Problem.** `src/api/shared.ts:21-22` accepts the bare token in `Authorization` with no
`Bearer` prefix, and `:23` accepts it in an `x-admin-token` header. Bare tokens and
custom auth headers leak through proxy logs, misconfigured log shippers, and referrer
chains far more readily than a standard `Authorization: Bearer` header.

**Design.** Require the `Bearer ` prefix. Drop `x-admin-token` from both `isAdmin` and
the CORS `allowHeaders`. Normalize and length-check before the constant-time compare.

---

## 7. SEC-006 — Weak `ADMIN_TOKEN` is issued with only a warning (MEDIUM)

**Problem.** `src/api/admin/index.ts:38-40` logs a warning when the configured token
fails the strength policy, then hands it out anyway. The policy is advisory, so it is
not a control.

**Design.** Fail closed. If the configured `ADMIN_TOKEN` does not satisfy
`isStrongToken` (>= 32 chars, not a placeholder), login refuses to issue it and returns
a 500 naming the remediation. **This is a behaviour change: the deployed `ADMIN_TOKEN`
must be at least 32 characters** or admin login will stop working until it is rotated.
This spec's own decision to do it is the point — an advisory check is not a control.

---

## 8. SEC-007 — Unauthenticated resource exhaustion (MEDIUM)

| # | Site | Defect | Fix |
| --- | --- | --- | --- |
| 1 | `src/api/compare.ts:22-26` | Unanchored `%…%` LIKE → full `models` scan, **no `LIMIT`** | Add `LIMIT 8` and apply the visibility gate, so the scan is bounded and only covers rows the caller may see. Note: the `?model=` (by-name) path cannot consult the cache before resolving ids, because the id set *is* the cache key. The `?models=` (by-id) path does hit the cache first. One bounded scan on a name lookup is an acceptable cost; the unbounded one was not. |
| 2 | 5 of 6 cached routes | Cache key is the full URL including arbitrary query params, so `?x=<random>` creates a new cache object **and** forces a fresh origin D1 read. `og.ts` renders a PNG per unique URL | Build cache keys from validated params only |
| 3 | `src/api/models.ts:12-35` | `SELECT m.*` over the whole table, no `LIMIT` | Add a bounded `LIMIT` |
| 4 | `src/api/models.ts:52` | `Number(c.req.param("id"))` with no finite check, unlike siblings `:41` and `:148` → 500 instead of 400 | Reuse the existing id validator |
| 5 | `src/api/leaderboard.ts:228` | A transient empty read is cached 120 s under the same key as the normal response (`:136`), serving an empty leaderboard to everyone | Do not cache the empty/error path |

---

## 9. Gate hygiene

- Add `videos/` to `.gitignore`. It is untracked, currently breaks `npm run lint`
  (23 errors, so **CI is red**), and is one `git add .` from being committed.
- Redact the plaintext weak password from `SECURITY_AUDIT_REPORT.md:60`.
- `node_modules` is partially installed in this working copy: `npm test` fails
  (`vitest: not found`) and `npx tsc` cannot resolve. `node node_modules/vitest/vitest.mjs run`
  runs all 186 tests green. A clean `npm ci` is needed for the normal scripts to work.
  This is an environment defect, not a code one.

---

## 10. Explicitly not in scope

- Rotating the leaked keys (owner-only; §1).
- Cloudflare dashboard configuration: WAF OWASP ruleset, edge Rate Limiting Rules, Bot
  Fight Mode, TLS 1.2 minimum, D1 backups, queue DLQ alerts. These remain manual and are
  the authoritative layer for the distributed-attack cases that code alone cannot stop.
- The 5 dev-dependency advisories. `npm audit fix --force` would downgrade wrangler;
  CI already treats dev audit as advisory by owner decision (issue #21).
- ExFAT mount remount. Requires root, affects the whole volume, and risks locking the
  owner out of the drive if the mask is wrong. Offered in §1, not performed.
