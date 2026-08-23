# e01s06 — React dashboard

Status: pending

## Objective
Deliver Cloudflare Analytics + LLM leaderboard UI with live updates and 7-day graphs.

## Tasks
- Vite + React 18 + TS + Tailwind + shadcn/ui + Recharts, static via Workers assets.
- Header: LLM PERFORMANCE OBSERVATORY — OpenCode Zen + OpenRouter FREE MODELS ● LIVE
- Summary cards: FREE MODELS / ONLINE NOW / BEST TPS / BEST TTFT / BEST RELIABILITY / BENCHMARKS/24H
- Live leaderboard sortable columns (Rank Model Provider TPS Now/1h/24h/7d TTFT 7d Uptime Error% Status Last Test) + filters Provider/Model/Coding/General/Fastest/Lowest TTFT/Most Reliable/Online.
- 7-day TPS graph (multi-model, provider comparison, 1h/24h/3d/7d ranges, tooltip Time/Provider/Model/TPS/TTFT/Status) using hourly aggregates; separate TTFT graph (never same axis).
- Reliability Timeline (█ online ░ unavailable per model) + 7d uptime/downtime/incidents/longest outage; Error graph grouped {timeout,rate limit,5xx,4xx,model unavailable,stream error}.
- Same-model provider comparison panel + Overall Score leaderboard + recommendation cards (🏆BEST OVERALL ⚡FASTEST NOW 🚀LOWEST TTFT 🛡MOST RELIABLE 💻BEST CODING 📈BEST CONSISTENCY) linking to measurements.
- Live SSE via EventSource to /api/live; freshness ● LIVE Data updated 8s ago vs STALE DATA Last measurement 18m ago + last benchmark/discovery/aggregate timestamps. Never lies about staleness.
- /methodology page transparency (TPS/TTFT formulas, prompts, frequency, token counting, free detection, uptime, scoring, retention, limitations).
- Only necessary data rendered; show "2h of observed data" when <7d instead of faking.

## Verify
`npm run build && npm run typecheck`

## Acceptance
- Visual parity to Cloudflare Analytics / TokenDyno; responsive, dark theme.
- SSE updates rank without refresh; filters/sorts work.
- Methodology page complete.
