# e04s05 - Playwright validation plus deploy plus UAT (closes e04)

Last story of the TokenDyno-parity epic. No product code changes except what
validation forces (each a separate fix commit).

## Validation

- New gate test/e2e/parity-smoke.mjs (mirrors dashboard-smoke.mjs: dist bundle plus
  in-process mock API, no D1/DO/network). Covers: dashboard Rel 24h values, Thinking
  badge, intelligence link, 6-pin compare with shareable URL round-trip, models page
  groups plus detail links, model detail (stats, charts, intelligence, 404 state),
  pricing page, vs page, theme toggle persistence plus both-theme screenshots,
  zero console/page errors throughout.
- Run: npm run build first, then node test/e2e/parity-smoke.mjs and the existing
  npm run test:e2e. Screenshots land in dump/e2e (gitignored diagnostics).
- package.json gains test:e2e:parity. Maestro has no skill in this session catalog,
  so device-level maestro testing is out of scope; Playwright plus Vitest carry validation.

## Migrations and deploy

- Apply 0016+0017 locally (migrate:local) and remotely (migrate); verify schema
  (PRAGMA table_info) on both.
- vite build, then wrangler deploy (Pages front door per specs/state.yaml).
- Post-deploy: hit /api/health and /api/leaderboard on the public host,
  confirm fresh meta and new fields (uptime_24h, speed snapshot rows).

## UAT and close

- specs/verifications/UAT_TOKENDYNO_PARITY_2026-10-12.md: per-item checklist
  (every TokenDyno feature plus our enhancements) with evidence links.
- Mark e04s05 complete, epic e04 complete, and close the goal only when the
  checklist is fully evidenced.

## Rollback

- Deploy rollback: wrangler rollback or redeploy the previous version.
- Migration rollback: 0016/0017 are additive; leaving applied on code revert is safe.
