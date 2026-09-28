# Security Policy — ModelPulseX

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a Vulnerability

- Email: security@modelpulsex (or open a **private** GitHub Security Advisory)
- Do not open public issues for vulnerabilities
- We aim to respond within 48h and fix critical issues within 7 days
- Please include steps to reproduce, impact, and suggested fix if any

## Security Model

- **Stack:** Cloudflare Workers + D1 + Durable Objects + Queues + Cron + React Vite
- **Secrets:** Never in code, bundle, D1, or logs. Use `wrangler secret put` (ADMIN_TOKEN, ADMIN_PASSWORD, OPENCODE_API_KEY, etc.). `.env` and `.dev.vars` are gitignored and contain only local placeholders.
- **Auth:** Admin endpoints accept the session from an **HttpOnly** cookie (`mpx_session`) or `Authorization: Bearer <ADMIN_TOKEN>` (for curl/CI). The bare-token form and the old `x-admin-token` header were **removed** 2026-09-28. Login (`/api/admin/login`) requires `ADMIN_ID` + `ADMIN_PASSWORD` (both constant-time, symmetric 80-150ms jitter), then sets the session cookie and returns only a CSRF token — the session token never appears in a response body and is unreachable from JavaScript. State-changing admin requests must echo the CSRF token in `X-CSRF-Token`. Login is rate-limited 5/15m per IP by a **D1-backed** bucket (`login_attempts`, shared across isolates) with an in-memory slider as the first line, and every login attempt is audited. A configured `ADMIN_TOKEN` below 32 characters is **refused** rather than issued.
- **Rate Limits:** Global 120 req/min per IP, admin 30/min, login 5/15m (in-memory + D1 fallback). Cloudflare Rate Limiting Rules recommended in front.
- **Headers:** Strict-Transport-Security (preload), Content-Security-Policy, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP/COEP.
- **Input Validation:** All query params validated against allowlists (range, benchmark, sort, profile, provider slug, ids). Free-text search sanitized and length-capped. Payloads limited to 1MB.
- **SQL:** All queries use prepared statements with bound params (no string interpolation of user input). LIKE wildcards are sanitized and bounded.
- **SSRF:** Outbound provider URLs validated via `assertSafeApiUrl` (https only, loopback http allowed, no credentials/fragments).
- **XSS/CSRF:** React auto-escapes; no `dangerouslySetInnerHTML`. CSP blocks inline scripts (nonce optional). Same-site cookies where used, no auth via query string.
- **Dependencies:** Pinned, audited via `npm audit` in CI. Vite >=7.3.6, Vitest >=3.2.6 fix GHSA-fx2h, GHSA-5xrq etc. Update via Dependabot weekly.
- **Observability:** Structured audit logs for admin actions (fingerprint, not raw token), health + scheduler heartbeat, stale-data watchdog + webhook.

## Hardening Checklist (Max Level)

- [x] Secrets via wrangler secret store, never in repo
- [x] Constant-time token compare, strong token length enforcement (fail-closed since SEC-006)
- [x] Admin session in an **HttpOnly** cookie — not `localStorage` (SEC-001)
- [x] CSRF double-submit token on state-changing admin requests
- [x] `Bearer` prefix required; `x-admin-token` removed (SEC-005)
- [x] Rate limiting per IP + per route, 429 with Retry-After
- [x] **Cross-isolate** login throttle backed by D1 `login_attempts` (SEC-004)
- [x] CORS strict allowlist, no wildcard, credentials handling
- [x] Security headers (HSTS, CSP, COOP/CORP/COEP, etc.)
- [x] Input validation + payload size limits
- [x] Prepared SQL, LIKE sanitization, SSRF guard
- [x] Same visibility gate on public list **and** by-id routes (SEC-002)
- [x] Bounded cache keys, bounded catalogue/LIKE reads (SEC-007)
- [x] Audit logging without unauthenticated write amplification (SEC-003)
- [x] Dependency vuln scanning in CI; production deps 0 known vulns
- [x] File system deny for .env/.pem/.git, CSP meta fallback
- [x] Durable Object SSE per-IP limits and origin checks
- [x] Pre-commit secret scan (see scripts/secret-scan.js)

> **Known gap — not fixable in code.** `.env` / `.dev.vars` (plus `*.backup-*`)
> still hold live secrets in plaintext, and the project lives on an **exFAT**
> volume that has no Unix permission model — `chmod 600` is a silent no-op there
> and every file is effectively world-readable. Rotating the leaked keys is
> mandatory; see `specs/security-hardening-2026-09-28.md` §1.

## Secret Rotation

If `.env` or `.dev.vars` was ever committed or exposed:

1. Revoke immediately (Cloudflare dashboard, provider dashboards)
2. `wrangler secret put` with new values
3. Verify `git log -p --all -S "sk-" --oneline` shows no history
4. Add pre-commit hook: `npx gitleaks protect`

## Cloudflare Dashboard Recommendations

- Enable **Cloudflare WAF** with OWASP ruleset
- Add **Rate Limiting Rules**: 100/min per IP for `/api/*`, 5/15m for `/api/admin/login`
- Enable **Bot Fight Mode** (or Super Bot Fight for API)
- Set **TLS min version 1.2**, HSTS preload, Automatic HTTPS Rewrites
- Enable **D1 backups** (daily) and **Queue DLQ** alerts
