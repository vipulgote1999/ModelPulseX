# Free Models Research — 2026-08-23 (Live Snapshot)

Source: live provider catalogs fetched at 2026-08-23T16:50 UTC.
All pricing parsed as `pricing.prompt == 0 && pricing.completion == 0` for OpenRouter, heuristic `id.endswith('-free') || id==big-pickle` for OpenCode Zen (`https://opencode.ai/zen/v1/models`).

## Summary

- **OpenRouter total 422 models, FREE 22 (5.2%)** — down from ~30 in early 2025; recent removal of llama-3.3-70b:free etc. matches free-llm-router verification notes.
- **OpenCode Zen total 64 models, FREE 9 (14%)** — exactly the keyless tier: 1 exact (`big-pickle`) + 8 `*-free` family.
- **Combined unique free model identifiers 31 (some underlying models overlap, e.g., `laguna-s-2.1-free` vs `poolside/laguna-s-2.1:free` family).** Overlap handled as same display_name with provider comparison.
- **Pricing homogeneity:** every free OpenRouter is 0/0 prompt/completion; no mixed 0/positive found (0 near-free). Zen free has no pricing metadata via /models; relies on suffix contract; verifyFree will treat absence as FREE_STATUS=UNKNOWN and skip unless suffix matches known set.
- **Embedding free:** no dedicated embeddings:free except transitively via Zen `text-embedding-3-small` not in live free list — will be excluded until provider marks it free.

## OpenRouter FREE (22) — full table

| # | provider_model_id | display_name | context | modality | notes |
|---|-------------------|--------------|---------|----------|-------|
|1| stealth/ox-alpha | Ox Alpha | 1048576 | text+image+video→text | stealth provider placeholder; verify streaming works |
|2| dots-studio/dots-3-note-preview:free | Dots3-Note Preview (free) | 512000 | text+image→text | |
|3| liquid/lfm-2.5-2.6b:free | LFM2.5-2.6B (free) | 65536 | text→text | low context outlier |
|4| nvidia/nemotron-3.5-lightning:free | Nemotron 3.5 Lightning (free) | 1000000 | text→text | 1M |
|5| thinkingmachines/inkling-small:free | Inkling Small (free) | 262144 | text+image+audio→text | |
|6| poolside/laguna-s-2.1:free | Laguna S 2.1 (free) | 262144 | text→text | pair with Zen laguna-s-2.1-free |
|7| thinkingmachines/inkling:free | Inkling (free) | 262144 | text+image+audio→text | |
|8| poolside/laguna-xs-2.1:free | Laguna XS 2.1 (free) | 262144 | text→text | |
|9| cohere/north-mini-code:free | North Mini Code (free) | 256000 | text→text | code-capable |
|10| z-ai/glm-5.2:free | GLM 5.2 (free) | 256000 | text→text | |
|11| nvidia/nemotron-3.5-content-safety:free | Nemotron 3.5 Content Safety |128000| text+image→text | vision |
|12| nvidia/nemotron-3-ultra-550b-a55b:free | Nemotron 3 Ultra (free) |1000000| text→text | 1M |
|13| nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | Nemotron 3 Nano Omni |256000| text+image+audio+video→text | reasoning family |
|14| google/gemma-4-26b-a4b-it:free | Gemma 4 26B A4B |262144| text+image+video→text | |
|15| google/gemma-4-31b-it:free | Gemma 4 31B |262144| text+image+video→text | |
|16| google/lyria-3-pro-preview | Lyria 3 Pro Preview |1048576| text+image→text+audio | audio-output, NOT useful for chat benchmark |
|17| google/lyria-3-clip-preview | Lyria 3 Clip Preview |1048576| text+image→text+audio | audio-output |
|18| nvidia/nemotron-3-super-120b-a12b:free | Nemotron 3 Super (free) |262144| text→text | |
|19| openrouter/free | Free Models Router |200000| text+image→text | meta-router; benchmark separately but do not use for provider comparison |
|20| nvidia/nemotron-3-nano-30b-a3b:free | Nemotron 3 Nano 30B A3B |256000| text→text | |
|21| nvidia/nemotron-nano-12b-v2-vl:free | Nemotron Nano 12B 2 VL |128000| text+image+video→text | vision |
|22| nvidia/nemotron-nano-9b-v2:free | Nemotron Nano 9B V2 |128000| text→text | |

**Filtered for observatory:** exclude lyria audio-output (16,17) and optionally meta-router (19) from coding/short category but still show as free; include vision models only in vision-capable benchmark path. Net benchmarkable free chat/text: **19** models.

## OpenCode Zen FREE (9)

| # | provider_model_id | context_length (heuristic) | display_name |
|---|-------------------|----------------------------|--------------|
|1| big-pickle | 131072 | Big Pickle |
|2| deepseek-v4-flash-free | 131072 | DeepSeek V4 Flash Free |
|3| x-preview-f-free | 131072 | X Preview F Free |
|4| muse-spark-1.2-contributor-free | 131072 | Muse Spark Contributor Free |
|5| mimo-v2.5-free | 131072 | MIMO V2.5 Free |
|6| hy3-free | 131072 | HY3 Free |
|7| nemotron-3-ultra-free | 1000000 | Nemotron 3 Ultra Free |
|8| nemotron-3.5-lightning-free | 1000000 | Nemotron 3.5 Lightning Free |
|9| laguna-s-2.1-free | 262144 | Laguna S 2.1 Free |

Context heuristics from `src/config.ts` (memotron 1M, laguna 262k, others 131k). Capabilities text-only except legacy; no vision free currently.

## Discovery strategy (implemented)

- **OpenRouterAdapter.discoverModels():** `GET https://openrouter.ai/api/v1/models` with cache + ETag; filter `parseFloat(prompt)==0 && parseFloat(completion)==0`; map to Model {provider, id, display_name, context_length, capabilities from architecture.modality, input_price/output_price as strings, is_free=true, free_status=FREE, first_seen, last_seen }. Provide UNKNOWN if pricing missing.
- **OpenCodeZenAdapter.discoverModels():** `GET https://opencode.ai/zen/v1/models` (keyless) and with key if `OPENCODE_API_KEY` set; suffix check `id.endsWith('-free')||KNOWN_FREE_EXACT`; fetch detail per-model if pricing endpoint appears later; today no pricing field → treat suffix as FREE, others PAID/UNKNOWN and skip benchmarking. Must also fetch `GET /v1/models` via OpenAI compat if primary 404.
- **Re-discovery cadence:** Cron `*/15 * * * *` (or `0 * * * *` for pricing changes) refreshes models table, updates last_seen, inserts new rows, marks missing as inactive after 2 missed discoveries (but retains historical).
- **Previously Free handling:** `models.active=false`, `free_status=PREVIOUSLY_FREE` label; scheduler stops queueing benchmark jobs; dashboard shows last 7-day aggregates + "Previously Free" badge; if returns to free, re-activate.

## Metrics storage for 7-day requirement

- **Raw:** `benchmark_runs` 7-14d TTL, hourly cleanup removes >14d. Only necessary fields stored (see D1 schema s11). No response bodies.
- **Aggregates:** `hourly_model_stats` 30-90d, aggregates computed hourly via Cron. Used for 7-day charts to avoid scanning 1000s of raw rows.
- **If model disappears from free:** no new runs inserted; hourly stats frozen at last hour; API falls back to `latest` fallback query that still serves last result for up to 7d (active=false filter removed for history endpoints). Dashboard divider: "Last observed 2d ago" if stale.

## Only necessary data — enforcement

- Drop columns: no `response_text`, no `request_body`. Tokens via `usage` if present else tiktoken estimation flagged `token_estimation_method='heuristic'`.
- Aggregation precomputes p50/p90/p95 via approx percentile (manual sort per hour window, <200 samples/hour => exact).
- API never returns raw stream chunks.

## Change frequency expectation

Based on free-llm-router history: OpenRouter free set changes monthly (3-5 churn). Zen set stable (9 for 2 months). Cron daily at midnight UTC covers churn; also admin endpoint `POST /api/admin/discover` for manual refresh.

## Actions for implementation

- Implement adapters with above filters, with `+UNKNOWN skip` gate.
- Seed D1 with these 28 benchmarkable models on first migration.
- Cron schedule: `*/5 * * * *` for scheduler benchmark jobs, `0 * * * *` for discovery + aggregation + cleanup.
- Log discovery diff (added/removed/previously-free) for observability.

