# e01s02 — D1 schema + provider interface + dynamic discovery

Status: pending

## Objective
Implement relational schema plus `LLMProvider` contract and two real adapters with strict FREE filtering and 7-day retention of Previously Free.

## Tasks
- Finalize D1 schema: providers, models, benchmark_runs (14d raw), hourly_model_stats (90d), availability_incidents, benchmark_config with indexes.
- Implement `interface LLMProvider {getProviderName, discoverModels, getModelMetadata, benchmarkModel}` in `src/providers/index.ts` + `opencode-zen.ts` + `openrouter.ts`.
- OpenRouter: GET /models, filter `prompt==0 && completion==0`, map fields (display_name, context, capabilities from architecture.modality, pricing), set FREE/UNKNOWN.
- Zen: GET /zen/v1/models, suffix `*-free`+big-pickle, capabilities text heuristic, context heuristic (nemotron 1M etc.), UNKNOWN for non-free.
- Store first_seen/last_seen, active flag, Previously Free transition (stop scheduling, retain last result display).
- Seed benchmark_config with short/medium/coding prompts.

## Verify
`npm run migrate -- --local && npm test -- test/discovery.test.ts`

## Acceptance
- Live discovery against mocked catalogs returns 19-22 OpenRouter + 9 Zen free only.
- Paid/UNKNOWN not returned; Previously Free still queryable via history endpoints after 7d but inactive.
- D1 unique(provider_id, provider_model_id) enforced.
