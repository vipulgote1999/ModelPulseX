# UAT — TokenDyno parity epic (e04), 2026-10-12

Verdict: PASS with two noted follow-ups (stale prod pipeline predating the release;
maestro skill absent from the session catalog).

## Evidence

- Preflight: 311 vitest tests green, tsc clean, eslint clean, vite build green.
- E2E: dashboard-smoke 5/5, parity-smoke 7/7 (both themes, screenshots in dump/e2e).
- Migrations 0016 + 0017 applied locally and remotely; columns verified remotely
  (tps_method on benchmark_runs, uptime_24h on leaderboard_snapshot).
- Deploy: worker 277595e4-ec68-45a0-8de0-da03c56ec880; Pages redeployed twice
  (6d9c50b4 then 2ceeba85). /api/health 200. /api/leaderboard serves 83 rows
  WITH the uptime_24h key (new code live).

## Per-item checklist

- [x] Live leaderboard: TPS now/1h/24h/7d, TTFT, ITL, Rel 24h, 7d up, sparklines (24pt),
  status pills, measured labels, ranks — exceeds TokenDyno 24h-only view.
- [x] Hybrid TPS (inter-token vs wall-clock, tps_method persisted) + TTFT definition.
- [x] Fixed speed probe (TokenDyno-identical prompt, 300 cap) + coding probe retained.
- [x] Fresh session per run (single-turn, fresh ids; body-cache limit disclosed).
- [x] Muse Spark reasoning.effort minimal, visible-only TPS.
- [x] Per-tier cadence (Pro 10m, Free/Zen 60m, Go 30m/priciest 6h) + footer disclosure.
- [x] Providers: opencode_go + ollama_pro + 19 existing = 21, dynamic discovery,
  subscription catalogs default-disabled, verifyFree gate intact.
- [x] Compare up to 6 with shareable #/?compare= URL (round-trips in e2e).
- [x] Models catalog grouped by provider; model detail pages (stats, charts,
  intelligence, honest 404); leaderboard and catalog link to detail.
- [x] Pricing page (discovered rates, verify-at-source honesty) + vs page + FAQ.
- [x] Methodology documents hybrid, probes, sessions, cadence, intelligence sourcing.
- [x] Intelligence Index (43 models, CC-BY TokenDyno data, AA links) + thinking badges.
- [x] 24h reliability end-to-end (snapshot + live fallback + UI column).
- [x] Theme toggle (persisted, audited selectors, both themes screenshotted).
- [x] SEO (canonical, Dataset + FAQ JSON-LD, parse-validated).
- [x] Small reversible atomic commits (30 across e04), specs-first ledgers.

## Follow-ups (not blocking)

1. Prod pipeline was STALE at verify time (last benchmark 05:40 UTC, scheduler tick
   04:15 UTC — predates this release). uptime_24h snapshot values backfill on the
   next hourly refresh; API shape and live fallback are already live. File a
   scheduler-health ticket if the watchdog has not already paged.
2. Maestro testing: no maestro skill exists in this session catalog; Playwright
   (7/7 parity + 5/5 smoke) plus Vitest (311) carry validation.
3. MCP: openviking server disconnected and web_search keyless; worked via web_fetch.
4. Go /responses + /messages route variants remain out of scope (engine speaks
   OpenAI chat completions); recorded in the e04s02 spec.
