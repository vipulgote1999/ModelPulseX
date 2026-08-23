# e01s01 — Scaffold Wrangler+D1+Queue+DO+Cron+TS+Tests

Status: pending

## Objective
Initialize Cloudflare project structure `src/index.ts, providers/, benchmark/, db/, live/, api/, utils/, types/` + migrations + frontend Vite scaffold + shared test harness so subsequent stories have green Preflight.

## Tasks
- Init package.json (module, deps: wrangler, vite, react, recharts, vitest, ts, tailwind, hono/itty), tsconfig strict ESM, wrangler.jsonc with D1/Queue/DO/Cron/ai bindings, .dev.vars.example.
- Create migrations/0001_initial.sql matching s11 D1 schema.
- Create src/types.ts shared types (Provider, Model, BenchmarkResult etc.).
- Create test harness `test/setup.ts` mocking fetch/provider APIs.

## Verify
`npm run typecheck && npm test`

## Acceptance
- `npm install && npx wrangler dev` (or typecheck) succeeds without secrets.
- migrations apply locally `wrangler d1 migrations apply DB --local`.
