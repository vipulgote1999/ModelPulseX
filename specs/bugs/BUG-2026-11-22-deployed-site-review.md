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

### D11 — `npm run deploy:pages` cannot find the Pages project

- The script ran `wrangler pages deploy dist/frontend` with no project name.
  Wrangler found `wrangler.jsonc` but it has no `pages_build_output_dir`, so it
  ignored the file and failed with `Missing Pages project name`.
- The documented deploy command was therefore broken; add
  `--project-name modelpulsex`.

### D12 — Incidents for retired models stay open forever

- Production had 162 rows in `availability_incidents` with `ended_at IS NULL`,
  some opened in August 2026.
- `updateIncidents()` closes an incident only when the same model returns
  SUCCESS. An auto-disabled model or a model that leaves FREE never runs again,
  so its last outage remains "ongoing" indefinitely.
- Fix: close on auto-disable, plus a one-shot data fix for existing retired
  models (end = last observed run) and backfill `duration_seconds`.

### D13 — Light theme leaves dark islands and an unreadable leader card

- Gradients and a few fractional surface utilities were not in the light-theme
  block. The BEST OVERALL card stayed a dark violet gradient while its text
  flipped dark (low contrast), the leaderboard toolbar stayed
  `rgba(24,24,27,.7)`, and the mobile nav sheet stayed `#0a0a0f/95` in light
  mode.
- Fix: theme the gradient variables, `bg-zinc-900/70`, `bg-zinc-800/80`, and
  `bg-[#0a0a0f]/95`; assert the card gradient and toolbar colour in Playwright.

### D14 — `/api/timeouts` names top failing hidden models

- The `topModels` aggregate grouped raw runs with no model-visibility gate, so
  admin-disabled and inactive rows appeared by name in a public response —
  exactly the rows `/api/models` and `/api/models/:id` work to hide (SEC-002).
- Fix: restrict the named aggregate to `publicModelVisibilityWhere` and pin the
  gate in the SEC-002 suite. Provider-level counts stay ungated: they carry no
  model identity and are operational context.

### D15 — Incident start is stamped at the third failure, not the first

- `updateIncidents()` selected only `status` and inserted the current run's
  timestamp. An outage opened on the third consecutive failure therefore
  under-reported its duration by up to two benchmark intervals.
- Fix: select `started_at` too and use the oldest failing run in the streak as
  the incident start; the current run remains the fallback.

### D16 — Deploy tooling ships stale frontends

- `npm run deploy` did not build, and `deploy.bat` deployed only the Worker.
  After the Pages front-door cutover, both commands could leave the public SPA
  on an old bundle.
- Fix: make `npm run deploy` build first and update `deploy.bat`/README to
  deploy Worker **and** Pages.

### D17 — `npm run migrate` applies to the local DB, not production

- The script ran `wrangler d1 migrations apply DB` without `--remote`; Wrangler
  defaults to the local state directory. The README deploy section presented it
  as the production migration command, so a new migration could be reported
  successful while production never saw it.
- Fix: `migrate` now passes `--remote`; `migrate:local` remains the local one.

### D18 — `/api/cooldowns` exposes model rows without the visibility gate

- The public cooldown panel joined `model_cooldowns` to `models`/`providers`
  with only the expiry predicate, so an admin-disabled model's id, name and
  cooldown reason stayed public until retention cleanup ran.
- Fix: apply `publicModelVisibilityWhere` to the model join and pin it in the
  SEC-002 suite. Provider cooldowns stay ungated (provider names are public).

### D19 — Light-theme hover states erase labels

- Dark-theme hover pairs lighten text (`hover:text-white`) and darken surfaces
  (`hover:bg-zinc-800`). In light mode the surface stays light but the label
  still turns white — an invisible hover. The nav, table rows, buttons and
  links all use these pairs.
- Fix: flip both hover halves in the light-theme block and assert the nav
  hover colour in Playwright.

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
