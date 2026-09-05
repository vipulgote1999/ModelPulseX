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
- **Auth:** Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>` with constant-time compare. Login (`/api/admin/login`) requires `ADMIN_ID` + `ADMIN_PASSWORD` (both constant-time, symmetric 80-150ms jitter) and returns `ADMIN_TOKEN`; `ADMIN_TOKEN` alone is not accepted as password since 2026-08-30 (breaking change — configure `ADMIN_PASSWORD` via `wrangler secret put ADMIN_PASSWORD`; single-secret deployments must add it). Login is rate-limited (5/15m per IP) and audited.
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
- [x] Constant-time token compare, strong token length enforcement
- [x] Rate limiting per IP + per route, 429 with Retry-After
- [x] CORS strict allowlist, no wildcard, credentials handling
- [x] Security headers (HSTS, CSP, COOP/CORP/COEP, etc.)
- [x] Input validation + payload size limits
- [x] Prepared SQL, LIKE sanitization, SSRF guard
- [x] Audit logging, no secret leakage in logs/errors
- [x] Dependency vuln scanning in CI, 0 known vulns
- [x] File system deny for .env/.pem/.git, CSP meta fallback
- [x] Durable Object SSE per-IP limits and origin checks
- [x] Pre-commit secret scan (see scripts/secret-scan.js)

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
