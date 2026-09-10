# BUG-2026-09-09T090000: CI audit gate red on transitive dep vulns

## Problem

- Actual: CI `preflight` job fails at `npm audit
  --audit-level=moderate` with 6 transitive vulns
  (3 moderate, 3 high): `@vitest/mocker` (via vitest
  dev-dep), hono `<=4.13.4` (3 advisories), sharp (via
  miniflare/wrangler).
- Expected: green gate. All other CI steps (lint,
  vitest, typecheck, build) pass on the same run.

## Root Cause Analysis

None of the flagged packages are touched by
application code changes — no dependency was added
or bumped. Fixes require breaking major upgrades
(vitest 5, wrangler downgrade/upgrade), unsuitable
for an unrelated feature PR.

Security impact: LOW. All findings are in
devDependencies or local-tooling transitives
(vitest, wrangler/miniflare); none ship in the
Worker bundle. No exploit path in production.

## TDD Fix Plan

Tracked as follow-up, not in this PR:

1. ~~Merge dependabot hono 4.13.5 (open PR #3)~~ —
   superseded: `hono` bumped to `^4.13.7` directly.
2. Separate PR for vitest 5 / wrangler moves.

## Acceptance Criteria

- [x] hono findings cleared (bumped to `^4.13.7`, PR #3 closed superseded)
- [x] Remaining findings triaged in follow-up PR
- [x] This exception recorded (this file)

## Resolution

Accepted 2026-09-09: PR #8 merged with red audit
gate per owner decision; application steps green.

### 2026-09-10 — gate repaired (issue #21)

**Decision (owner, 2026-09-10):** narrow the blocking gate to real runtime
exposure; keep the full audit as an advisory signal.

**Verified facts that forced this shape** — the two remaining findings are
dev-only and have no forward fix:

- `sharp <0.35.4` arrives via `miniflare` → `wrangler`. Latest `wrangler@4.130.0`
  still pins `miniflare`'s `sharp@0.35.2`. The audit's own suggestion is a
  **downgrade** (`wrangler@4.15.2`), so `npm audit fix --force` moves the
  deploy toolchain backwards.
- `@vitest/mocker 2.1.0-4.1.10` arrives via `vitest@3.2.6`; the only fix is a
  `vitest@5.0.0` major across 18 test files.
- `hono <=4.13.4` was the **only** runtime dependency flagged. Bumped to
  `^4.13.7` — `npm audit --omit=dev --audit-level=moderate` now reports
  **0 vulnerabilities**.

**Implementation:**

- `.github/workflows/ci.yml` — blocking step is now
  `npm audit --omit=dev --audit-level=moderate`; the full-tree audit runs as a
  `continue-on-error: true` advisory step with the exception documented inline.
- `package.json` — `hono: ^4.13.7`.

**Evidence (local, branch `fix/github-issues-11-23`):**

| command | before | after |
| --- | --- | --- |
| `npm audit --omit=dev --audit-level=moderate` | exit 1 (1 moderate) | **exit 0, 0 vulnerabilities** |
| `npm audit --audit-level=moderate` | exit 1 (6 vulns) | exit 1 (5 dev-only) → advisory, non-blocking |
