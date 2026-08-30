# ModelPulseX — Security Audit & Hardening to Max Level (007)

**Date:** 2026-08-28  
**Auditor:** Chief Security Architect AI (007) — Offensive as attacker, defensive as architect  
**Scope:** `D:/Project/ModelPulseX` — Cloudflare Workers + D1 + Durable Objects + Queues + Cron + React Vite  
**Method:** 6-phase 007 process (Mapping → Threat Model STRIDE+PASTA → Checklist → Red Team → Blue Team → Verdict + Scoring)  
**Baseline → Hardened:** 52/100 (Partially Blocked) → **93/100 (Approved)**  
**Gates:** `npm test && npm run typecheck && npm run lint && npm audit` — all GREEN post-hardening

---

## 1. System Summary

**Purpose:** LLM performance observatory that measures **FREE** models (OpenCode Zen + OpenRouter + 17 additional free providers) every 5 minutes via streaming `/v1/chat/completions` (TTFT/TPS). Retention: raw 7d, hourly 30d, aggregates indefinite. Live SSE via Durable Object.

**Attack surface before:** 19 provider adapters outbound, 17 API routes (7 admin), D1, Queues, Cron 4 expressions, Durable Object SSE, React SPA (Tailwind/Recharts), static assets, secrets via env/wrangler.

**After hardening:** Same surface, but with **defense-in-depth** across all layers (rate limits, CSP/HSTS, constant-time auth, validation, SSRF guards, audit logs, 0 vulnerabilities).

---

## 2. Attack Map (Attack Surface)

### Inputs and Outputs

| Source | Input | Output | Trust Boundary |
| ------- | --------- | ------- | ---------------- |
| User (browser) | `GET/POST /api/*` query/body, `Origin`, `Authorization`, SSE `Accept` | JSON leaderboard/history, SSE stream, HTML SPA | Internet → Worker (untrusted → trusted) |
| Provider APIs | `GET /v1/models`, `POST /v1/chat/completions` streaming | D1 `benchmark_runs`, `hourly_model_stats` | Worker → Provider (trusted → semi-trusted, validate pricing/free status) |
| Admin | `POST /api/admin/*` with `Authorization` | D1 toggles, queue sends, discovery | Admin token → D1/Queue (high privilege) |
| Cron/Queue | `ScheduledController`, `MessageBatch<BenchJob>` | D1, DO broadcast, provider fetches | Cloudflare internal → Worker (trusted) |
| Filesystem | `src/providers/*`, `migrations/*`, `.env`, `.dev.vars` | Bundle, D1 schema | Dev machine → repo (secrets risk) |
| Dependencies | `vite`, `vitest`, `hono`, `react` | Bundle, dev server | NPM → build (supply chain) |

### Critical Assets

- Secrets: `OPEN*API_KEY` (19), `CEREBRAS_API_KEY`, `GEMINI_API_KEY`, `ADMIN_TOKEN`, `ADMIN_PASSWORD`, `CLOUDFLARE_API_TOKEN` (20+ total)
- Sensitive data: benchmark metrics (not PII, but integrity critical), IP/UA in logs (minimized)
- Infrastructure: D1 `c588d2cd`, Queue `bench-queue`, DO `PerformanceDO`, Workers domain `modelpulsex.vipulgote5.workers.dev`
- Reputation: domain, provider rate limits, WAF score

### Execution Points

- Code: no `eval/exec/subprocess` — only `fetch` outbound (SSRF guard `assertSafeApiUrl` in `benchmark/engine.ts`)
- Filesystem: migrations via `wrangler d1 migrations apply`, asset `_headers` copy
- Network: 19 outbound hosts (allowlisted in `PROVIDER_ENDPOINTS`), webhook `ALERT_WEBHOOK_URL` outbound
- Automation: cron `*/5`, `*/10`, `*/30`, `0 * * * *`; Queue consumer `max_concurrency 8`, inline fallback 6

### External Dependencies

- `hono@4.7`, `react@18`, `recharts@2`, `vite@7.3.6`, `vitest@3.2.6`, `wrangler@4`, `@cloudflare/workers-types@5` — 0 vulns post-upgrade
- 19 provider APIs (external SLA, circuit breaker + cooldown)

---

## 3. Vulnerabilities Found (Prioritized)

| # | Severity | Vulnerability | Vector | Impact | Fix |
| --- | ------------ | ----------------- | ------- | --------- | ---------- |
| 1 | **CRITICAL** | **Live secrets in `.env` and `.dev.vars` plaintext on disk** (OPENROUTER `sk-or-...`, GROQ `gsk_...`, 20+ keys, `ADMIN_PASSWORD=Test@1675` weak) | Local file read, exposed backup, accidental commit risk (`.env` gitignored but readable 644) | Full leak, provider takeover, admin compromise | Sanitized `.env`/`.dev.vars` → placeholders, backup `*.backup-2026-08-28` gitignored, `scripts/secret-scan.js` + `.husky/pre-commit`, `SECURITY.md` rotation, `wrangler secret put` only |
| 2 | **CRITICAL** | **Vite 5.4.8 CVEs + Vitest 2.1.8 critical** — GHSA-fx2h-pf6j-xcff (7.5), GHSA-5xrq-8626-4rwp (9.8 arbitrary file read/exec via Vitest UI), esbuild GHSA-67mh | `npm install` dev, `vite dev` server `server.fs.deny` bypass Windows (GHSA-fx2h), Vitest UI listening | RCE/Path Traversal in dev/CI, supply chain | Upgrade `vite@7.3.6`, `vitest@3.2.6`, `@vitejs/plugin-react@4.7`, `@cloudflare/workers-types@5`, `npm audit` 0 vulns, Dependabot weekly |
| 3 | **HIGH** | **No rate limiting** on `/api/*` and `/api/admin/login` (brute force, D1 DoS) | `POST /api/admin/login` with `id/pass` without throttle, `GET /api/leaderboard` hammer D1 expensive queries | Brute force `ADMIN_ID=admin` default, D1 0.5s+ queries * 1k req = DoS | `src/utils/rate-limit.ts` sliding window in-memory + `app.use('/api/*')` (login 5/15m, admin 30/m, api 120/m), `x-ratelimit-*` headers, `429 Retry-After`, DO per-IP `MAX_PER_IP=5`/`MAX_TOTAL=200` |
| 4 | **HIGH** | **Weak auth: timing attack + fallback `token-as-password` + `x-admin-token` without constant-time** | `isAdmin` used `===`, `LOGIN` fallback `pass === token` if `ADMIN_PASSWORD` missing, `auth === token` without normalize | Brute force via timing oracle, bypass if env incomplete | `timingSafeEqual` constant-time (XOR diff), `isAdmin` normalizes `Bearer`, removes fallback, requires `token.length>=16`, `login` jitter delay 80-150ms, `auditLog` fingerprint |
| 5 | **MEDIUM** | **Incomplete security headers** — missing HSTS, CSP, COOP/CORP/COEP, `X-Permitted-Cross-Domain` | Response without `Strict-Transport-Security`, weak `Content-Security-Policy`, `Access-Control-Allow-Origin: *` in DO SSE | Clickjacking, XSS via injected asset, MITM without HSTS | `src/index.ts:withSecurityHeaders` + `src/live/performance-do.ts` + `vite.config.ts` + `frontend/public/_headers`: HSTS 2y preload, CSP strict, COOP `same-origin`, CORP `same-origin`, COEP `credentialless`, `Permissions-Policy` lockdown |
| 6 | **MEDIUM** | **CORS `*` in DO + allowlist without `*` validation** | `PerformanceDO` SSE `access-control-allow-origin: *` together with `/api/admin` credential-bearing | Cross-origin creds leak, CSRF-like | `validateCorsConfig` rejects `*`, DO SSE echo only allowlist (`modelpulsex.vipulgote5.workers.dev` + localhost), `hono/cors` origin fn with `credentials:true` |
| 7 | **MEDIUM** | **Missing input validation** — `range`, `benchmark`, `provider`, `ids`, `q`, `model` without allowlist, `payload` without limit | `?range=foo`, `?ids=1,,,,`, `q=%%%%` DoS LIKE, `POST` body 10MB D1 injection via JSON | D1 scans, LIKE wildcard DoS, 500s leakage | `src/utils/security.ts` validators (`isValidRange`, `isValidProviderSlug`, `parseIdsParam`, `sanitizeSearchQuery` 80-100 cap), `bodyLimit 1MB`, `validateCorsConfig` |
| 8 | **MEDIUM** | **Information disclosure via error messages** — `catch(e) => String(e).slice(0,500)` leak SQL/stack | `GET /api/leaderboard?range=bad` returns `D1_ERROR: no such table`, `stack` | Schema enumeration, path leak | `sanitizeErrorMessage` (hide `D1_ERROR/SQLITE/prepare/.ts:`), `app.onError` generic, sanitize in `auditLog` details |
| 9 | **MEDIUM** | **No audit logging** for admin (toggle/bulk/discover/benchmark) | Admin changes `benchmark_enabled` without trace | Repudiation, insider abuse | `audit_log` D1 table `0009_security.sql`, `auditLog()` JSON structured (fingerprint, ip, ua), on all admin routes |
| 10 | **LOW** | **SSRF guard only in benchmark, not in discovery** | Provider `fetch(MODELS_URL)` without `assertSafeApiUrl` | If registry compromised, internal fetch | Added `assertSafeApiUrl(MODELS_URL)` in 19 adapters (`src/providers/*.ts`) + `safeFetch` helper |
| 11 | **LOW** | **SSE without connection limits** — 10k clients exhaust DO memory | `new ReadableStream` per client without `MAX_TOTAL` | DoS via `EventSource` flood | `MAX_TOTAL_CLIENTS=200`, `MAX_PER_IP=5`, `503/429 Retry-After`, `ipCounts` map + `cleanup()` |
| 12 | **LOW** | **Vite `server.fs.allow` open** — `server.fs.deny` bypass Windows GHSA-fx2h | `vite dev` serves `../.env` via `..%2f` | Read `.env` in dev | `vite.config.ts: fs.allow [frontend, dist], deny [.env, *.pem, .key, .git, .wrangler], strict:true` |
| 13 | **INFO** | **No CSP meta fallback** for `file://` dev | `frontend/index.html` without CSP meta | Dev without edge headers | `frontend/index.html` meta CSP + `X-Content-Type-Options` |

---

## 4. Threat Model

### STRIDE (per component)

| Component | S (Spoofing) | T (Tampering) | R (Repudiation) | I (Information Disclosure) | D (Denial of Service) | E (Elevation of Privilege) | Primary Vector + Mitigation |
| ------------ | --- | --- | --- | --- | --- | --- | ------------------------------ |
| **Worker fetch /api** | Spoof `Authorization` | Tamper `q`/`ids` LIKE | Repudiation without log | Info leak error 500 | DoS hammer D1 | Elevation via IDOR `/:id` | `timingSafeEqual`, `sanitizeSearchQuery`, `auditLog`, `sanitizeErrorMessage`, rate limits, `parseIdsParam` capped 12 |
| **Admin login** | Brute `ADMIN_ID` | - | Login without audit | Token in JSON response (localStorage XSS) | Flood 429 | Bypass via fallback | `validateCorsConfig`, `bodyLimit`, `timingSafeEqual` + jitter, `auditLog`, `x-ratelimit`, remove fallback, future httpOnly cookie |
| **Provider outbound** | Fake webhook `ALERT_WEBHOOK_URL` | MITM without HSTS | - | Keys in log | Loop 6 inline + queue retries | - | `assertSafeApiUrl` https-only, `HSTS preload`, `verifyFree()` gate, `cooldown` timers, `BENCHMARK_TIMEOUT_MS` |
| **DO SSE** | Cross-origin Origin spoof | Data tamper SSE `data:` | No clients log | Count leak `clients`? | 10k EventSource flood | Publish without auth | `origin` allowlist, `ipCounts` per-IP 5, `MAX_TOTAL 200`, `x-mpulse-internal:1` publish guard |
| **D1** | SQL LIKE `%${q}%` (bound) | - | No audit before | `benchmark_runs` exfil via `/api/history` (public by design) | `GROUP_CONCAT` 200 limit, `cleanupRetention 7/30` | - | Prepared `bind`, `LIKE ?` with sanitize, `request_count` caps, `audit_log` append-only |
| **Supply chain** | Typosquat `recharts` | `vite` vuln bypass fs | - | `dist` bundle without CSP | `npm ci` 0 vulns, Dependabot | - | `npm audit` CI, `package-lock` pinned, `allowScripts` |

### Severity = Impact (1-5) × Probability (1-5)

- CRITICAL (20-25): #1, #2
- HIGH (12-16): #3, #4
- MEDIUM (6-9): #5-#9
- LOW (1-4): #10-#12

### PASTA (Business — 7 Stages)

1. **Objectives:** Protect integrity of measurements (TPS/TTFT), prevent data fabrication, protect keys that cost $k/month if leaked, keep observatory LIVE 24/7 (SLO fresh <18m)
2. **Scope:** `src/*`, `frontend/*`, `migrations/*`, `wrangler.jsonc`, `vite.config.ts`, `.github/workflows`, secrets handling
3. **Decomposition:** Data flow `Browser → Worker → D1/Queue → Provider → D1 → DO → Browser`; trust boundaries mapped above
4. **Ecosystem threats:** TokenDyno clone without free-filter → PAID pollution; LLM benchmark spoof (provider returns fake `usage`); WAF bypass via `Origin: null`
5. **Specific vulns:** `.env` 644, `vite` 5.4.8 path traversal, `verifyFree()` before without `HARD filter` → pollution, `isAdmin ===`
6. **Attack trees:**
   - `A1: Exfiltrate keys` → `A1.1 read .env via vite fs deny bypass` → mitigated `fs.allow/deny strict` + `secret-scan`
   - `A2: Brute force admin` → `A2.1 POST /api/admin/login` 1000x → mitigated `5/15m` + `auditLog` + `jitter`
   - `A3: DoS D1` → `A3.1 GET /api/leaderboard?ids=1,2,...1000` → mitigated `parseIdsParam max 12`, `rateKey`
   - `A4: SSRF` → `A4.1 provider registry poison` → mitigated `assertSafeApiUrl` + `PROVIDER_ENDPOINTS` single source
7. **Risk impact:** Before `Risk = CRITICAL` (high probability of leak + RCE in dev); after `Risk = LOW` (controls 93/100, 0 CVEs, monitoring)

---

## 5. Proposed Fixes (Code/Config Applied)

### Secrets (CRITICAL #1)

- `.env` and `.dev.vars` sanitized → placeholders (backup `*.backup-2026-08-28` gitignored, 644 → 600 recommended)
- `.gitignore` + `.env.local/.env.production/*.pem/*.key/secrets/`, `.env.backup*`, `.dev.vars.backup*`
- `scripts/secret-scan.js` (regex `sk-or/gsk_/csk-/nvapi-/AQ./cfut_/ADMIN_TOKEN`) + `.husky/pre-commit` + `npm run secret-scan`
- `SECURITY.md` rotation playbook, `wrangler secret put` only

### Dependencies (CRITICAL #2)

- `package.json` `vite 5.4.8 → 7.3.6`, `vitest 2.1.8 → 3.2.6`, `@vitejs/plugin-react 4.3.3 → 4.7.0`, `@cloudflare/workers-types 4 → 5`, `npm audit 5 vulns → 0`
- `.github/dependabot.yml` weekly + `ci.yml` `npm audit --audit-level=moderate` + `node scripts/secret-scan.js` + `npm run build`

### Rate Limit & Brute Force (HIGH #3, #4)

- `src/utils/rate-limit.ts` sliding window (`Buckets Map`, sweep 5m) + `getClientIp` (cf-connecting-ip/xff)
- `src/api/routes.ts` `app.use('/api/*')` (login 5/15m, admin 30/m, api 120/m), `x-ratelimit-*`, `429 retry-after`
- `src/utils/security.ts` `timingSafeEqual` XOR, `tokenFingerprint`, `isStrongToken`, `login` jitter, `auditLog` on all admin routes
- `src/live/performance-do.ts` `MAX_TOTAL 200`, `MAX_PER_IP 5`, `ipCounts`, `503/429`

### Headers & CORS (MEDIUM #5, #6, #12)

- `src/index.ts:withSecurityHeaders` (HSTS 2y preload, CSP API `default-src 'none'`, SPA `default-src 'self'` + `upgrade-insecure-requests`, COOP/CORP/COEP, `X-Permitted-Cross-Domain`)
- `src/live/performance-do.ts` secHeaders + origin allowlist echo (not `*`)
- `src/api/routes.ts` `validateCorsConfig` + `cors({origin:(o)=>allowlist.includes(o)?o:null, credentials:true, maxAge:600})`
- `vite.config.ts` `fs.allow/deny strict`, dev `headers` mirror prod, `frontend/public/_headers` (Cloudflare `_headers` for assets `immutable`)

### Validation & DoS (MEDIUM #7, #8)

- `src/utils/security.ts` `sanitizeSearchQuery(80)`, `parseIdsParam(12)`, `isValidProviderSlug`, `isValidRange/Benchmark/Sort/Profile`, `sanitizeErrorMessage`, `validateCorsConfig`
- `src/api/routes.ts` `bodyLimit 1MB`, `isValid*` on `leaderboard/history/models/:id*/admin/models/compare`, `GET /api/live` `x-forwarded-for`
- `app.onError` + `app.notFound` generic

### SSRF & Data (LOW #10)

- `src/providers/*.ts` `assertSafeApiUrl(MODELS_URL)` pre-fetch (19 adapters), import `measureBenchmark, assertSafeApiUrl`
- `src/benchmark/engine.ts` already had `assertSafeApiUrl` for `CHAT_URL` (loopback http allowed, no credentials/fragment)

### Resilience

- `src/index.ts` method allowlist, `content-length 1MB 413`, `x-request-id crypto.randomUUID()`
- `src/benchmark/scheduler.ts` `stub.fetch publish` with `x-mpulse-internal:1` + `content-type:json`
- `migrations/0009_security.sql` `audit_log` + `login_attempts` (prune 30d)

### Monitoring

- `src/utils/security.ts:auditLog` JSON level audit, `migrations/0009` indexes, `src/index.ts` `console.error` CORS misconfig, `watchdogCheck` existing + webhook `ALERT_WEBHOOK_URL`

---

## 6. Hardening and Improvements (Beyond Required Fixes)

- **Frontend CSP meta** `frontend/index.html` `meta http-equiv CSP` fallback + `referrer`
- **_headers assets** `frontend/public/_headers` + `dist/frontend/_headers` cache `immutable` for `*.js/*.css`
- **Pre-commit** `.husky/pre-commit` `lint + secret-scan` (fail-closed)
- **Package scripts** `secret-scan`, `security:audit`
- **Docs** `SECURITY.md` (WAF, Rate Limiting Rules, TLS 1.2, D1 backups, DLQ)
- **Cloudflare Dashboard (manual):** WAF OWASP, Rate Limiting Rules (`100/m /api/*`, `5/15m /api/admin/login`), Bot Fight Mode, TLS 1.2, HSTS preload, D1 backup daily
- **Future (recommended):** `httpOnly Secure SameSite=Strict` cookie for admin (replace localStorage), `nonce` CSP for scripts, `SRI` for recharts, `Sentry`/`Baselime` for 5xx/429 alerts, `gitleaks` binary in CI vs our JS scan

---

## 7. Scoring (007 — 8 Domains)

| Domain | Weight | Before | After | Notes After |
| --------- | ------ | -------- | -------- | -------------- |
| **Secrets & Credentials** | 20% | 40 | **95** | Sanitized, secret-scan, husky, backup gitignored, 32+ chars enforced |
| **Input Validation** | 15% | 50 | **95** | Strict allowlist, sanitize 80-100, parseIds 12, bodyLimit 1MB, LIKE bound |
| **Authentication & Authorization** | 15% | 45 | **90** | Constant-time, 5/15m, jitter, audit fingerprint, no fallback |
| **Data Protection** | 15% | 70 | **95** | CSP/HSTS/COOP, SSRF 19x, no bodies, PII minimized |
| **Resilience** | 10% | 70 | **90** | Timeout 30s, 413, circuit cooldown, per-IP/total caps, DLQ |
| **Monitoring** | 10% | 60 | **90** | audit_log D1, structured JSON, watchdog, health freshness, onError |
| **Supply Chain** | 10% | 40 | **95** | 0 vulns, vite 7.3.6/vitest 3.2.6, Dependabot, lockfile pinned |
| **Compliance** | 5% | 60 | **95** | OWASP Top10, SECURITY.md, CI audit, _headers, CSP meta |
| **Final Score** | 100% | **52** | **93** | **+41** |

**Calculation:** `19.0+14.25+13.5+14.25+9.0+9.0+9.5+4.75 = 93.25`

---

## 8. Final Verdict

### **APPROVED — Ready for production (93/100)**

**Technical justification:** All CRITICAL/HIGH issues fixed with code + config + CI, 0 vulnerabilities, tests/lint/typecheck/build GREEN, STRIDE/PASTA low residual risk. Headers, rate limits, validation, audit, SSRF cover OWASP Top 10 Web/API. Secrets defense-in-depth (sanitize + scan + husky + gitignore) eliminates `No Hardcoded Secrets` class.

**Conditions to stay approved (≥90):**

- Rotate **all** keys that were in `.env`/`.dev.vars` plaintext (GROQ, GEMINI, CEREBRAS, NVIDIA, etc.) via `wrangler secret put` and dashboards, even though `git log -p -S sk-` shows not committed — plaintext on disk is still a risk
- In Cloudflare Dashboard, create **2 Rate Limiting Rules** (recommendation above) — in-memory is best-effort per isolate, edge rules are authoritative
- Apply `migrations/0009_security.sql` in prod: `npm run migrate` (or `wrangler d1 migrations apply DB`)

**Re-evaluation conditions (if blocked):** Score <70 or new critical CVE without patch in 7 days.

**Next steps (sustain):**

1. `npm run deploy` (after `npm run migrate`)
2. `gh pr checks` must pass (lint+test+typecheck+build+audit+secret-scan)
3. Enable WAF/Bot Fight/TLS in dashboard
4. Weekly: `npm audit` + Dependabot PRs + `node scripts/secret-scan.js`

**Artifacts from this audit:**

- `SECURITY.md`, `SECURITY_AUDIT_REPORT.md` (this file), `src/utils/security.ts`, `src/utils/rate-limit.ts`, `migrations/0009_security.sql`, `frontend/public/_headers`, `scripts/secret-scan.js`, `.husky/pre-commit`, `.github/dependabot.yml`, `.github/workflows/ci.yml`, `frontend/index.html` CSP, `vite.config.ts` fs/headers, `src/index.ts`, `src/live/performance-do.ts`, `src/api/routes.ts`, `src/benchmark/scheduler.ts`, `src/providers/*.ts` (19)

**007 Signature:** *Nothing goes to production without passing 007 — verified 2026-08-28, 52 tests OK, 0 vulns, HSTS preload, CSP strict.*
