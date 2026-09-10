# BUG-2026-09-10-leaderboard-labels: zero-sample rows labelled "Measured TPS" and ranked

GitHub: #11 (from Linear MED-171..MED-185 follow-up). Severity: P2 — no fabricated
numbers (gated metrics are `null`), but the honesty label contradicted the row state.

## Problem

- **Actual:** all 90 rows of the live leaderboard carried
  `measured_tps_label: "Measured TPS"` (a constant at `src/api/leaderboard.ts:652` and
  `:280`), and `rank` was assigned by array index for every row — 22 of 90 rows had
  **zero** samples in the last 24h and still received a numeric rank.
- **Expected:** the label reflects the gating outcome for that row, and a rank is only
  claimed where there is comparable evidence.

Live probe 2026-09-10T11:45Z (`/api/leaderboard?range=7d`): 90 rows; `sampleCount24h`
min 0 / median 8 / max 78; example
`{"model":"meta-llama/Llama-3.1-70B-Instruct","sampleCount24h":0,"tps_now":null,"rank":68,"measured_tps_label":"Measured TPS","status":"UNKNOWN"}`.

## Root Cause Analysis

Gating was already correct (`MIN_SAMPLES`, `gatedMedian()` / `gatedRaw()` null the
metrics) — the defect is purely presentational and structural:

1. The label was a **string literal** in both row builders, so it could not vary by row.
2. `finish()` numbered rows with `scored.forEach((r, i) => (r.rank = i + 1))` — the array
   index was the rank, independent of whether the row had any evidence.
3. The frontend hardcoded the same words a third time (`Leaderboard.tsx`: "Measured TPS"
   fallback) and rendered `{r.rank}` unconditionally, so it could not express "unranked".

## Fix (decision + implementation)

**Decision (deliberate, #11 asks for one):** unranked-but-visible. A model needs
`MIN_SAMPLES.w24h` (= 3) runs in the last 24h to hold a rank. Below that it stays in the
list, sorted after the ranked set, with `rank: null` rendered as `—` and a `title`
explaining why. Rationale: a rank is a comparative claim; rows that measured nothing
today cannot support it, and hiding them entirely would look like the provider vanished.

Pure helpers in `src/utils/metrics.ts` (unit-tested, Cloudflare-free):

- `measuredTpsLabel(samples24h, tps24h) → "Measured TPS" | "Insufficient samples" | "No recent data"`
- `isRankEligible(samples24h) → samples24h >= MIN_SAMPLES.w24h`
- `assignRanks(rows)` — numbers eligible rows 1..n, sinks the rest with `rank: null`

Applied at both row builders in `src/api/leaderboard.ts` (snapshot fast path + live
fallback) and in `finish()`, so the two paths cannot drift. `LeaderboardRow.rank` is now
`number | null`; the UI renders the API's label (amber when not "Measured TPS").

## Acceptance Criteria

- [x] Label derived per row from the gating outcome, not a constant
- [x] Rank policy decided, implemented and documented (README + `/methodology`)
- [x] Pinned by tests: `test/metrics.test.ts` covers a zero-sample row (label + `rank: null`
      + sunk position) and `test/api.test.ts` guards against re-hardcoding the constant
      and against the UI dropping the unranked marker

## Verification

- `npx vitest run test/metrics.test.ts test/api.test.ts` → 22 passed
- `tsc --noEmit` clean (root tsconfig includes `frontend/src`), `eslint .` clean
- Prod smoke after deploy: a row with `sampleCount24h: 0` must report
  `measured_tps_label: "No recent data"` and `rank: null`.
