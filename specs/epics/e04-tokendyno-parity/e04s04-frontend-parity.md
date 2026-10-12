# e04s04 - Frontend parity (compare-6, pages, pricing, vs, theme, SEO)

Source: TokenDyno compare, models, pricing, vs, about pages plus theme toggle plus
JSON-LD Dataset/FAQ (rounds 1-2 research) plus repo conventions.

## Gaps (all verified in-tree)

- Compare caps at 3 pins (Leaderboard.toggle, ChartModelSelector, Dashboard copy);
  API already allows 8 ids. No shareable URL: selection lives in component state.
- No models page, no model detail page, no pricing page, no vs page.
  App has useState page switching (dashboard, methodology, admin, docs) with no URLs.
- Dark-only UI (index.html class dark, hardcoded zinc utilities).
- index.html SEO is basic (title, description, OG); no Dataset or FAQ JSON-LD.
- Footer is generic; no sampling-cadence disclosure.

## Design

1. Compare-6 plus shareable URL:
   - Pin cap 3 goes to 6 in Leaderboard.toggle, ChartModelSelector, Dashboard chartIds;
     default top-3 unchanged (charts stay readable); copies say max 6.
   - Pure helpers in frontend/src/lib/router.ts: parseHash (page plus model id)
     plus parseCompareIds and formatCompareHash; covered by test/router.test.ts.
   - Dashboard hydrates selection from the compare hash param on mount and writes
     it back on change (page router owns the hash path). No loops: writes only
     follow state changes, reads only on mount.
   - Compare is the dashboard panel plus shareable URL (no separate route).
2. Hash router plus nav:
   - Routes: empty or #/ dashboard; #/models; #/model/ID; #/pricing; #/vs;
     #/methodology; #/docs; #/admin. Unknown hashes fall back to dashboard.
   - Header navigates via hash and highlights current; footer methodology link uses hash.
   - Each page lands in its own commit with its nav entry (no dead links).
3. Models page: GET /api/models grouped by provider_name (alpha), rows link to
   detail; free-status and active chips; counts header. Read-only.
4. Model detail page (#/model/ID): /api/models/:id plus /api/compare?models=ID summary
   plus /api/models/:id/history charts (reuse lazy Tps/Ttft/Reliability charts with
   single-model series), intelligence block (score link, thinking badge), 404 state
   for hidden or unknown ids (never confirm hidden rows exist beyond 404).
5. Pricing page: /api/providers freeTier notes plus /api/models per-model
   input/output prices grouped by provider; honest as-discovered dating plus
   verify-at-source note; static billing blurbs for Zen, Go, Ollama (sourced
   from round-2 research, attributed). No invented rates: null prices render as dash.
6. Vs page: static factual table (ModelPulseX vs TokenDyno vs Artificial Analysis
   vs LiveBench) plus FAQ; positions us honestly (speed observatory, not capability).
7. Theme plus SEO plus footer:
   - Persisted toggle (mpx-theme, default dark): data-theme light override layer in
     index.css mapping the zinc utility patterns actually used (about 20 rules).
     Reversible in one file; verified by build plus e04s05 screenshots.
   - index.html: canonical, Dataset JSON-LD (measurementTechnique hybrid TPS, 24h
     reliability; distribution /api/leaderboard), FAQ JSON-LD (our real answers).
   - Footer: sampling-cadence disclosure (cron tick, speed take, tier cadences).

## Tests

- test/router.test.ts: hash parse/format round-trips, compare id strict parsing
  (positive ints, dedupe, cap 6), unknown pages fall back.
- Existing suites keep passing; vite build stays green (per-commit).
- e04s05 Playwright covers the new pages visually (both themes).

## Rollback

Each commit revertible via git revert. Pages are additive route branches;
removing one is a nav-entry plus lazy-import delete. Theme revert is one CSS
block plus toggle delete (dark stays default).
