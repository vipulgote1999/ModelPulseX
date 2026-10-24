# Pages Front Door — name-free production URL (URL-001)

**Status:** COMPLETE — steps 1-5 shipped 2026-09-28 (Worker `523b8e13`)
**Date:** 2026-09-28
**Goal:** serve the dashboard at `https://modelpulsex.pages.dev` so the Cloudflare
account subdomain (`vipulgote5`) is no longer part of the public URL.
**Supersedes:** the `2026-08-23` decision in `SESSION.md` ("keep `modelpulsex.vipulgote5.
workers.dev` as THE production URL") and the `session.deployment.url` annotation in
`specs/state.yaml`, which both encode "no zone registered, custom domain declined".

---

## 0. Why the name is there, and why renaming cannot fix it

`workers.dev` URLs are **always** `<worker-name>.<account-subdomain>.workers.dev`.
Verified against the live account on 2026-09-28:

| Fact | Value | How verified |
| --- | --- | --- |
| Worker name | `modelpulsex` — already clean | `wrangler.jsonc:3` |
| Account subdomain | `vipulgote5` | `GET /accounts/{id}/workers/subdomain` |
| Zones in account | **0** | `GET /zones` → empty |

The name is a property of the **account**, not the project. Renaming the Worker cannot
remove it. The only two things that can: a Custom Domain (needs a zone, i.e. a purchased
domain) or a host that is not `*.workers.dev`.

---

## 1. Why NOT a full port to Pages

A full port was the first proposal and it is **not possible**. Two hard platform
blockers, both quoted from current Cloudflare docs:

| Blocker | Doc text | What it would break |
| --- | --- | --- |
| Queue **consumers** | "You cannot currently configure a queues consumer with Pages Functions." (Pages wrangler-config) / "it is not possible to consume events from a queue with a Pages Function. You will have to create a separate consumer Worker." (Pages bindings) | `bench-queue` consumer → the benchmark engine. This is the app. |
| Durable Object **classes** | "You must create a Durable Object Worker and bind it to your Pages project... You cannot create and deploy a Durable Object within a Pages project." | `PerformanceDO` → live SSE leaderboard |

A port would leave the data-collection pipeline with nowhere to run. Rejected.

## 2. Chosen architecture: Pages as front door, Worker as private backend

The Worker's public hostname is *disabled*, not deleted. All compute (cron, queue
consumer, DO, D1) stays in the Worker, byte-for-byte unchanged.

```
  browser
     │  https://modelpulsex.pages.dev            (public, no account name)
     ▼
┌──────────────────────────────────────────────┐
│ Pages project "modelpulsex"                  │
│  • Vite SPA served from CDN (dist/frontend)  │
│  • _headers  — already exists, native format │
│  • _redirects — NEW, SPA fallback            │
│  • functions/api/[[path]].ts — NEW, ~20 LOC  │
└──────────────────────┬───────────────────────┘
                       │ service binding "API"  (internal, never over the internet)
                       ▼
┌──────────────────────────────────────────────┐
│ Worker "modelpulsex"  (unchanged)            │
│  cron ×4 · bench-queue consumer · DO · D1   │
│  workers_dev: false  ← public route OFF      │
└──────────────────────────────────────────────┘
```

**Key simplification:** the Pages project needs **no** D1, DO, or Queue bindings. It
holds exactly one binding — the service binding. The Worker remains the only thing that
touches state, so there is no duplicated query logic and no second source of truth.

**Consequence:** `modelpulsex.vipulgote5.workers.dev` stops resolving. The name is
removed, not merely hidden behind a redirect.

## 3. Why this is low-risk

| Risk | Mitigation |
| --- | --- |
| Breaking the live benchmark pipeline | The Worker is not modified except for one `workers_dev` key, added **last**, after Pages is verified. |
| SSE (`/api/live`) buffered by the proxy and killing the live leaderboard | The proxy returns the downstream `Response` object directly — no `text()`, no `json()`, no buffering. Covered by a dedicated streaming test (§6). |
| Admin session cookie breaking on a new origin | Cookies are **host-only** (`HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain=` — `src/utils/admin-session.ts:36-40`). A host-only cookie is scoped to whatever host serves the response, and `Set-Cookie` is forwarded verbatim. No change needed. |
| Frontend API calls breaking | All 12+ call sites use **relative** `/api/...` paths — no absolute origin, no base URL to rewrite. |
| CORS breakage | The browser only ever talks to one origin (`pages.dev`). CORS stops being a live surface rather than becoming a new one. `CORS_ORIGIN` is repointed to the new host so the server-side allowlist still validates. |
| `wrangler.jsonc` is not a valid Pages config | Pages config lives in a **separate** `wrangler.pages.jsonc`. The Worker config keeps `main`, `queues.consumers`, `triggers.crons`, and `durable_objects`, none of which are valid Pages keys. |

## 4. Files

| File | Action | Notes |
| --- | --- | --- |
| `functions/api/[[path]].ts` | **new** | Proxy. Returns the downstream Response unmodified. |
| `test/pages-proxy.test.ts` | **new** | Unit + streaming tests (§6). Matches `include: ["test/**/*.test.ts"]`. |
| `frontend/public/_redirects` | **new** | `/* /index.html 200` — replaces Worker `assets.not_found_handling: "single-page-application"`. |
| `wrangler.pages.jsonc` | **new** | `name`, `pages_build_output_dir: "./dist/frontend"`, `services`, compat flags. |
| `wrangler.jsonc` | **edit (phase 5)** | Add `"workers_dev": false`. |
| `package.json` | **edit** | `deploy:pages` script. |
| Hardcoded origins (7 sites) | **edit** | See §5. |
| `specs/state.yaml` | **edit** | `session.deployment.url` → pages.dev. |
| `README.md`, `deploy.bat`, `blog-draft.md` | **edit** | Public URL references. |

`frontend/public/_headers` already exists in native Pages format and needs no change.
`vite.config.ts` already emits to `dist/frontend`, which is exactly
`pages_build_output_dir`. `nodejs_compat` is already a compat flag on the Worker and
must be repeated in the Pages config.

## 5. Hardcoded origins to repoint (7 sites)

| File:line | Role |
| --- | --- |
| `src/api/routes.ts:34,40` | CORS allowlist default |
| `src/utils/security.ts:97` | CORS validation default |
| `src/live/performance-do.ts:152` | DO SSE origin echo allowlist |
| `src/api/openapi.ts:18` | OpenAPI `servers[].url` |
| `frontend/src/pages/Docs.tsx:49` | Docs page base URL |
| `frontend/index.html:25` | `og:image` absolute URL |
| `src/benchmark/engine.ts:151` | `HTTP-Referer` sent to upstream providers |

`CORS_ORIGIN` is an existing env var (`src/types.ts:323`) — repointing it is a secret
write, not a code change.

## 6. Verification (all must pass before phase 5)

1. `npm test` — 261 existing tests still green, plus new proxy tests
2. `npm run typecheck` — clean
3. `npm run lint` — clean
4. `vite build` succeeds and `dist/frontend` contains `index.html` + `assets/`
5. Pages deploy; then against `https://modelpulsex.pages.dev`:
   - `/` → 200 dashboard
   - `/api/health` → 200
   - `/api/leaderboard?range=7d` → 200, non-empty rows
   - **SSE:** `/api/live` emits `data:` frames progressively — measured over ≥10s, not
     just "connection opened". A buffered proxy returns 200 and then nothing; this is
     the single most important check in the migration.
   - Deep link `/models/123` → 200 (proves `_redirects` SPA fallback)
6. `curl` the old workers.dev URL → NXDOMAIN (proves the name is gone, not redirected)

## 7. Rollback

Phases 1–4 touch nothing live. The only production-mutating step is phase 5.
Rollback is a single edit: remove `"workers_dev": false` from `wrangler.jsonc`, redeploy
the Worker, and the old URL serves again. D1, the queue, and the DO are never
destructive in this plan.

## 8. Sequencing

1. Proxy function + `_redirects` + `wrangler.pages.jsonc` + tests + npm script
2. Repoint the 7 origins and `CORS_ORIGIN`; redeploy Worker (workers.dev still live)
3. Build + deploy Pages; run all of §6 against pages.dev
4. **Stop. Confirm with the owner.**
5. Only then: `workers_dev: false` + redeploy Worker + update docs/specs

Steps 1–2 are reversible with no data impact. Step 5 is the only irreversible-ish one
and is gated on explicit sign-off.

## 9. Platform constraints discovered during implementation

These cost real time and are not obvious from the docs. All four are load-bearing.

1. **`wrangler pages deploy -c <path>` is rejected**: "Pages does not support
   custom paths for the Wrangler configuration file." Pages only reads a config at
   the default root path — which `wrangler.jsonc` already occupies for the Worker.
   Pages is therefore configured through the project (dashboard/API) while the
   Worker keeps its file, and `wrangler pages deploy dist/frontend` is run with the
   directory argument. Do NOT try to make the root config serve both: the Worker
   file carries `main`/`queues.consumers`/`triggers`/`durable_objects`, which are
   not valid Pages keys, and moving the Worker config has a far larger blast radius.

2. **The Pages project API takes `services` as a Map, not an array.** An array
   returns `8000006 Request body is incorrect`. Correct shape:
   `{"deployment_configs":{"production":{"services":{"API":{"service":"modelpulsex","environment":"production"}}}}}`
   Note `wrangler`'s own Pages schema has no `services` key at all, so the local
   bundle is not a reliable reference for this field.

3. **`_redirects` must not live in the shared build output.** `dist/frontend` is
   uploaded by both deployments. Workers static assets validate `_redirects` and
   reject `/* /index.html 200` as an infinite loop (error **100324**) — Workers uses
   `assets.not_found_handling: "single-page-application"` instead, already set in
   `wrangler.jsonc`. Pages needs exactly that rewrite for client-side routing. It is
   therefore written by `scripts/write-pages-redirects.mjs` at Pages deploy time,
   not committed to `frontend/public/`. Chosen over `.assetsignore` because the
   precedence of that file between the two asset pipelines is undocumented.

4. **`dist/frontend` is shared, so the two deploys sabotage each other in
   sequence.** `dist/` persists between commands, so a Pages deploy leaves
   `_redirects` in place and the *next* Worker deploy fails with 100324. Fixed with
   `scripts/pages-redirects.mjs write|clean`, which both deploy scripts call, making
   the order irrelevant. (Learned the hard way: the step-5 Worker deploy failed
   first time for exactly this reason.)

5. **`/api/*` is safe from the `/*` SPA rewrite.** Per Cloudflare: "Redirects
   defined in the `_redirects` file are not applied to requests served by Pages
   Functions, even if the Function route matches the URL pattern." No `_routes.json`
   is needed.

### Verification results (2026-09-28)

All of section 6 passed against `https://modelpulsex.pages.dev`:

| Check | Result |
| --- | --- |
| `/` | 200 `text/html` |
| `/models/123` deep link | 200 — SPA fallback live |
| `/api/health`, `/api/providers`, `/api/cooldowns` | 200 through the service binding |
| `/api/leaderboard?range=7d` | 200 with **69 real rows** (D1 read through the full chain) |
| `/api/live` SSE | 3 chunks over 30s, **30.0s arrival spread** (snapshot t+1.09s, keepalive t+31.11s) — unbuffered |
| SSE vs direct Worker baseline | identical pattern, ~0.5s added first-byte latency |
| DO origin gate | `access-control-allow-origin: https://modelpulsex.pages.dev` echoed |
| Real asset `/assets/index-*.js` | 200 `application/javascript`, 47,773 bytes — not shadowed by the rewrite |
| Security headers | HSTS, CSP, `X-Frame-Options: DENY`, nosniff all present from `_headers` |
| Old workers.dev | still 200 — rollback intact |

> A first SSE check reported a false FAIL. It only counted lines beginning with
> `data:`, discarding the DO's initial `: connected` comment frame, and the DO emits
> no `data:` events while idle (they fire on benchmark completions). The re-test
> above measures chunk arrival times, which is assumption-free. Worth remembering:
> an idle DO is not a broken proxy.

### Step 5 outcome (2026-09-28)

- `workers_dev: false` set in `wrangler.jsonc`; Worker redeployed as `523b8e13`.
- `modelpulsex.vipulgote5.workers.dev` now returns a Cloudflare **404 / error 1042**
  instead of the app. (DNS still resolves — `*.workers.dev` is a wildcard — so DNS is
  not the signal here; the 404 is.)
- The retired origin was removed from the DO allowlist in `src/live/performance-do.ts`,
  with a test asserting it is now **rejected** (`403`, no ACAO).
- Cron (4 triggers) and the `bench-queue` producer/consumer are unaffected.
- SSE re-verified after the change: `chunked`, ACAO scoped to
  `https://modelpulsex.pages.dev`, **59.9s arrival spread** — unbuffered.
- All endpoints 200, leaderboard still returning 69 rows.
- Rollback is one line: delete `"workers_dev": false` and redeploy.

## 10. Open items for the owner (not fixable in code)

Per `specs/security-hardening-2026-09-28.md` §1, still outstanding and **not** addressed
by this plan:

- Rotate `CLOUDFLARE_API_TOKEN` — it sits in a world-readable file on an exFAT volume
  and can deploy code and read every Worker secret.
- Rotate all provider keys and `ADMIN_PASSWORD` (`Test@1675` is in git history).
- The dev toolchain cannot run on exFAT at all (no symlinks). This plan was implemented
  from a Linux-native copy at `/home/vipul/Project/ModelPulseX`; the exFAT checkout is
  stale and cannot run `npm test`/`typecheck`/`lint`.
