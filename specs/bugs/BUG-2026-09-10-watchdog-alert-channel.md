# BUG-2026-09-10-watchdog-alert-channel: staleness watchdog cannot alert in production

GitHub: #22 (mirrors Linear MED-184). Severity: P1.

## Problem

- **Actual:** `watchdogCheck()` had no `ALERT_WEBHOOK_URL` in production (17 secrets, none
  matching), so a stalled pipeline produced only a `console.warn`. `last_stale_alert_at`
  stayed `null` and the alert path was a permanent no-op. It also ran only on the hourly
  cron while `STALE_ALERT_MINUTES` defaults to 30 — worst-case detection ~60 min.
- **Expected:** a stall is operator-visible, and watchdog configuration is part of health.
- **Evidence:** `npx wrangler secret list` (2026-09-10) → no `ALERT_WEBHOOK_URL`;
  `src/db/health.ts` absent-webhook branch returned without logging.

## Root Cause Analysis

Two independent defects, one symptom:

1. **Unobservable channel.** The no-webhook branch returned early and silently — by design
   it avoided stamping `last_stale_alert_at` (correct: don't pretend an alert went out),
   but it also emitted nothing, so "no alert configured" and "pipeline healthy" looked
   identical in logs.
2. **Wrong tick.** Evaluation lived in the `0 * * * *` branch. An hourly evaluator cannot
   honour a 30-minute threshold: the worst case between a stall starting and the next
   hourly tick is ~60 minutes.

Not a secret-management bug: setting the secret is an operator action (deferred by owner
2026-09-10 — no webhook URL available), so the code must be honest when it is unset.

## TDD Fix Plan

1. Pure `alertChannelState(env) → "configured" | "log-only"` + unit tests.
2. `watchdogCheck()` reports `channel` and logs at **error** level on every stale
   evaluation while `log-only`, without stamping `last_stale_alert_at` (so configuring
   the secret makes the next tick fire immediately).
3. Move evaluation to the `*/5` tick (`runWatchdog()`), keeping the 1-alert/hour rate limit.
4. Expose `scheduler.alert_channel` on `/api/health?freshness=N`.
5. Docs: README + `/methodology` state the tick and the `log-only` state.

## Budget check (issue #12 overlap)

`MAX(started_at)` on `benchmark_runs` plans as
`SEARCH benchmark_runs USING COVERING INDEX idx_benchmark_runs_started` (1 row), plus the
`scheduler_health` singleton: ~600 rows/day for 288 ticks — negligible against the 5M/day cap.

## Acceptance Criteria

- [x] Stale + unconfigured logs an error every evaluation (test asserts the call + text)
- [x] `alert_channel` reported on the public scheduler block
- [x] Evaluated on the `*/5` tick, so a 30-minute threshold is honoured within ~5 minutes
- [x] Rate limit unchanged (one alert/hour) and delivery failures still do not stamp
- [ ] **Forced-stale drill with a delivered alert** — needs a real webhook secret (owner
      action, no URL provided 2026-09-10). Code path is covered by tests; prod reports
      `alert_channel: "log-only"` until the secret exists.

## Verification

- `npx vitest run test/watchdog.test.ts test/stats-cooldown-health.test.ts` → 21 passed
- `tsc --noEmit` clean, `eslint .` clean on the branch
- Prod smoke after deploy: `/api/health?freshness=10m` → `scheduler.alert_channel: "log-only"`
