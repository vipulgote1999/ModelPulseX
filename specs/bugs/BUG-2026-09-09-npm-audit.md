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

1. Merge dependabot hono 4.13.5 (open PR #3) —
   non-breaking, clears 3 moderate findings.
2. Separate PR for vitest 5 / wrangler moves.

## Acceptance Criteria

- [ ] hono findings cleared via PR #3
- [ ] Remaining findings triaged in follow-up PR
- [ ] This exception recorded (this file)

## Resolution

Accepted 2026-09-09: PR #8 merged with red audit
gate per owner decision; application steps green.
