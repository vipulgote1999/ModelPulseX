# BUG-2026-11-22: Deployed-site review — security, API contract, and UI defects

Live review of `https://modelpulsex.pages.dev` (Worker version 877c472d, Pages
build `264f41f`) on 2026-11-22. Evidence: Playwright desktop/mobile sweeps,
D1 production queries, and direct API probes.

## Defects

### D1 — Batch history and id-based compare bypass the public visibility gate

- `/api/models/320513` correctly returns 404 for an admin-disabled model
  (`benchmark_enabled=0`), and `/api/models/320513/history` also 404s.
- `/api/history?ids=320513` returns that model's full hourly TPS/TTFT series
  (120 runs in the last 7 days). `/api/compare?models=320513` returns its
  windowed medians.
- SEC-002 states every public by-id route applies the same gate as the list
  routes. The batch history route and the `models=` branch of compare were
  missed (the existing test only covered `/api/compare?model=` search).

### D2 — OG share card ranks by peak single-run decode TPS

- `/api/og.png` showed `16200.0 TPS`, `14400.0 TPS`, `8350.0 TPS` while the
  leaderboard's ranked end-to-end 7d medians top out at ~516 TPS.
- Cause: `SELECT MAX(br.tps)` over raw runs. A single 1-token/1ms burst wins,
  and decode TPS is explicitly diagnostic-only in this project.
- Expected: active FREE models ranked by `e2e_tps_7d` from
  `leaderboard_snapshot` (the same ranked metric as the dashboard).

### D3 — Theme preference script is blocked by the CSP

- Every page logs a CSP violation for the inline `mpx-theme` restore script;
  `script-src 'self'` blocks it. Reloading after a theme switch falls back to
  dark, so the persisted preference never applies.
- The same page also logs a `frame-ancestors`-in-meta notice; the edge header
  already sets `frame-ancestors 'none'`, so the meta copy is dead weight.

### D4 — Mobile/tablet header clips navigation

- At 390 px the header content is 804 px wide inside a 390 px viewport
  (`overflow-x-clip` on the root). Pricing, vs Others, Docs, Methodology,
  Admin, and the theme toggle are unreachable by touch.
- At 768 px Methodology, Admin, API, and the theme toggle are clipped.

### D5 — Reliability timeline percentage contradicts its own bars

- Model detail showed `5% hours fully up` beside 75 of 76 green bars.
- Cause: bars turn green at `success_rate >= 0.5` and the legend says
  `hour fully successful (≥50% success)`, but the percentage counts only
  `success_rate >= 1`.
- Expected: percentage and bars use one threshold; label matches.

### D6 — Recommendation cards can recommend inactive/previously-free models

- Backend `recommendationCards()` filters `active && free_status === "FREE"`.
- Frontend `SummaryCards` / `RecommendationCards` select across every row, so
  "MOST RELIABLE" can show a `PREVIOUSLY_FREE`, `active:false` model with zero
  24h samples. The dashboard promises currently-free recommendations.

### D7 — `/api/timeouts` caches on the raw URL

- Every other cached public route was hardened in SEC-007 to key on only the
  params it varies by. `/api/timeouts` still uses `new Request(c.req.url)`, so
  `?junk=<random>` mints cache entries and forces a fresh 7d raw scan.
- The existing cache-key test only asserts the key contains `range=7d`; it
  never sends a junk param, so the regression is invisible.

### D8 — Per-model history raw fallback omits end-to-end metrics

- `/api/models/:id/history`'s raw fallback aliases `tps` to both
  `avg_tps`/`median_tps` but does not select `e2e_tps`, `itl_ms`, or
  `chunk_count`.
- The chart contract is `median_tps` + `median_e2e_tps`; without the latter the
  client falls back to decode TPS, silently labeling decode as end-to-end.

### D9 — Leaderboard silently accepts out-of-contract enum values

- OpenAPI declares enums for `benchmark`, `sort`, and `profile`;
  `/api/leaderboard?benchmark=bogus` returns 200 with a partially-empty board
  and `?sort=bogus` silently sorts by overall.
- Bad input should 400 like `range`, so monitors and clients fail loudly.

### D10 — Chart selector advertises 3 models but the dashboard supports 6

- `MAX_COMPARE = 6` and the leaderboard lets you pin 6 models, but
  `ChartModelSelector` renders only 3 slots and says "pick up to 3 models".
- Expected: one documented limit (6) everywhere.

## Fix plan (atomic commits)

1. Gate `/api/history` and `/api/compare?models=`; extend SEC-002 tests.
2. Key `/api/timeouts` cache on validated range; strengthen SEC-007 test.
3. Add e2e/ITL/chunk fields to the per-model history raw fallback; test.
4. Rank the OG card from snapshot `e2e_tps_7d`; test the query source.
5. Externalize theme init, drop meta `frame-ancestors`; assert no CSP errors.
6. Responsive header with a menu below `lg`; Playwright mobile test.
7. Fix reliability percentage threshold; filter recommendation cards to
   active FREE models; test both.
8. Validate leaderboard/history enums and update OpenAPI; test 400s.
9. Render all 6 chart slots; align copy; Playwright interaction test.
10. Add a Maestro web flow covering the above and run it on chromium.

## Verification

- `npm test && npm run typecheck && npm run lint`
- `npm run build && npm run test:e2e`
- Playwright live sweep (desktop + 390 px + 768 px) against the deployed build
- Maestro web flow against the deployed build
