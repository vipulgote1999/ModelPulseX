# BUG-2026-09-10-dead-timeout-config: BENCHMARK_TIMEOUT_MS read by nothing

GitHub: #23 (mirrors Linear MED-185). Severity: P2 — no wrong behaviour, but config that
reads as a live hard control.

## Problem

- `wrangler.jsonc` set `"BENCHMARK_TIMEOUT_MS": "30000"` and `src/types.ts` declared
  `BENCHMARK_TIMEOUT_MS?: string`, with **no reader** anywhere in `src/`, `frontend/`,
  `test/` or `scripts/`. The engine takes its timeout from the workload definition
  (`opts.benchmark.timeout_ms`; the shipped coding workload uses `300_000` — commit `3e358ae`).
- Operators tuning a "global 30s timeout" changed nothing, and the next person to "fix"
  the dead var would have silently regressed the 300s coding budget.

## Fix (decision: delete — the workload owns its timeout)

1. Removed the var from `wrangler.jsonc` and the declaration from `src/types.ts`.
2. Corrected the one prose reference (`SECURITY_AUDIT_REPORT.md` row for provider outbound
   controls) to name the real mechanism: per-workload `timeout_ms`.
3. Added `test/env-config.test.ts` so the class cannot come back:
   - every `vars` key in `wrangler.jsonc` must appear in at least one `src/` file;
   - every declared `Env` key must appear in at least one `src/` file (declaration is not a consumer);
   - `BENCHMARK_TIMEOUT_MS` must not reappear in either file.

A wiring alternative (an explicit override with documented precedence) was rejected: the
timeout belongs to the workload, and two sources of truth for it is exactly how the 30s/300s
confusion arose.

## Acceptance Criteria

- [x] Dead var + declaration deleted
- [x] Prose reference corrected
- [x] Regression guard added (a new dead config key now fails `npm test`)

## Verification

- `npx vitest run test/env-config.test.ts` → 3 passed (24 wrangler vars all consumed,
  all declared Env keys consumed, `BENCHMARK_TIMEOUT_MS` absent)
- `tsc --noEmit` clean, `eslint .` clean
