# ModelPulseX — AI Agents

Read CONVENTIONS.md before any GitHub or git operation.

<!-- BEGIN bigpowers:project -->
## Project
ModelPulseX is a Cloudflare-native LLM Performance Observatory that continuously benchmarks FREE models from OpenCode Zen and OpenRouter, storing 7-day metrics with live SSE updates.
Stack: TypeScript / Cloudflare Workers + D1 + Queues + Cron + Durable Objects / React + Vite + Tailwind + shadcn/ui + Recharts

## Commands
| Action | Command |
|--------|---------|
| Run (dev) | `npm run dev` (wrangler dev) |
| Test | `npm test` (vitest) |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` (vite build + wrangler) |
| Lint | `npm run lint` |
| Preflight | `npm test && npm run typecheck && npm run lint` |
| Deploy | `npm run deploy` (wrangler deploy) |
| Migrate | `npm run migrate` |
| CI | `gh pr checks` (when PR open) |

## Architecture
Workers API (adapters/benchmark engine/scoring/aggregation) → D1 (models,runs,hourly_stats,incidents,config) + Durable Object live SSE + Queue + Cron scheduler → React dashboard (leaderboard, 7-day TPS/TTFT/reliability/error graphs, provider comparison). Provider abstraction: OpenCodeZenProvider + OpenRouterProvider implement LLMProvider.

## Conventions
- Pure logic (TPS/TTFT/scoring/window math, free-detection, adapters) stays Cloudflare-free and unit-tested via Vitest.
- All benchmark state lives in D1 + Durable Object broadcast; never in KV or globals.
- Providers are data + behavior in providers/; benchmark engine never hardcodes model lists.
- Specs are YAML-first in specs/; specs/state.yaml is SoT for active flow.
- Only store necessary data: raw benchmark_runs 7-14d, hourly aggregates 30-90d, aggregates indefinite for metadata/incidents; never store response bodies.

## Never
- Never hardcode API keys or free-model lists; discovery MUST be dynamic via provider APIs with FREE_STATUS=UNKNOWN skip.
- Never fabricate benchmark data; show "Xh of observed data" when <7d.
- Never benchmark paid or unknown pricing models; verifyFree() gate before queueing.
- Never dismiss reproducible gate failures as pre-existing or out of scope.
- Never proceed on red Preflight or red CI — invoke quick-fix or fix-bug first.
- Never store response bodies unless debugging explicitly enabled.
- Never use total duration for TPS; MUST use generation_time = completed_at - first_token_at.

## Agent Rules
- **Workflow Mandate:** You MUST use the bigpowers skills (e.g. plan-work, develop-tdd, orchestrate-project) to perform tasks. DO NOT write code directly in response to a user prompt like "build this feature".
- **Always Green:** Preflight and CI must be green before forward work. Reproducible gate failures require fix-or-log per CONVENTIONS § Discovered Defects.
- Read specs/ before writing code.
- All planning and specifications MUST be written to specs/ before any code is generated.
- Write the minimum code that solves the stated problem. Nothing extra.
- Run tests after every change. Show evidence before declaring done.
- One clarifying question beats a wrong assumption baked into 200 lines.
<!-- END bigpowers:project -->

<!-- BEGIN bigpowers:context-routing -->
## Context Routing
| Glob | Sub-AGENTS.md |
|------|---------------|
| `src/providers/**` | Provider abstraction, dynamic discovery, free filtering |
| `src/benchmark/**` | Streaming measurement, TTFT/TPS, workload definitions |
| `src/db/**` | D1 schema, migrations, queries, aggregation, retention |
| `src/live/**` | Durable Object SSE, fan-out, live freshness |
| `frontend/**` | React dashboard, leaderboard, charts, comparison, scoring |
<!-- END bigpowers:context-routing -->

<!-- BEGIN bigpowers:learned-preferences -->
## Learned Preferences
- (empty — update as preferences are discovered)

## Workspace Facts
- ModelPulseX lives at D:/Project/ModelPulseX; free-llm-router at D:/Project/free-llm-router is reference, not dependency.
- OpenCode Zen free detection: *-free suffix or pricing 0; OpenRouter: pricing.prompt==0 && pricing.completion==0.
<!-- END bigpowers:learned-preferences -->

<!-- BEGIN bigpowers:tooling -->
## Tooling
- wrangler ^4.x, vite 5, vitest, typescript 5.7 strict, tailwind, recharts/echarts
<!-- END bigpowers:tooling -->
