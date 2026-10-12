# e04s03 - Intelligence index plus thinking badges plus 24h reliability

Source: TokenDyno overview API (api.ollamatps.com, fetched 2026-10-12, 71 rows,
64 with aaIntelligence) plus TokenDyno models page annotations plus repo conventions.

## Researched facts

- TokenDyno overview row: latestTps, latestTtftMs, lastTestedAt, avgTps24h,
  successRate24h, sampleCount24h, sparkline[24], thinkingCapable (true/false/null),
  aaIntelligence, aaUrl, aaReasoningModel.
- thinkingCapable is only populated on Ollama rows (true, except mistral-large-3 false);
  all Go and Zen rows carry null. aaReasoningModel is true nearly everywhere;
  false for nemotron-3-nano and mistral-large-3 (shown as non-reasoning on the models page).
- TokenDyno Dataset JSON-LD declares CC-BY 4.0; AA scores belong to Artificial Analysis (per-model link).
- Our gaps: AA map covers 10 OpenRouter ids with 2026-09-24 scores (stale vs TokenDyno 2026-10-12);
  no thinking flag anywhere; leaderboard shows uptime_7d only (no 24h reliability);
  snapshot has sample_count_24h but no 24h success rate; SNAPSHOT_BENCHMARKS lacks speed.

## Design

1. Intelligence table rebuild (frontend/src/lib/intelligence.ts, single source, no API change):
   - One entry per Artificial-Analysis model (dedupe overview rows by aaUrl):
     score, url, thinking (OR-merge of thinkingCapable; null when all null),
     reasoningModel (aaReasoningModel, OR-merge with false winning).
   - Aliases: every observed TokenDyno slug plus our provider_model_id variants
     (including -free-suffixed Zen ids and OpenRouter family ids where the family matches).
   - getAAMeta(id): exact alias, then normalized retry (lowercase, strip trailing
     -free and :free). getAA(id) stays compatible (score plus url).
   - Entries WITHOUT a TokenDyno row are dropped (no source, never stale-carry),
     except none: every kept entry cites the 2026-10-12 fetch.
   - Attribution header in-file: TokenDyno CC-BY 4.0 plus Artificial Analysis links.
2. Thinking badges (Leaderboard): Thinking pill when meta.thinking is true;
   non-reasoning note when meta.reasoningModel is false; nothing when unknown.
   Never invent: null renders no badge.
3. 24h reliability (TokenDyno successRate24h parity):
   - Raw snapshot pass gains ok_24h and tot_24h (SUM CASE on the 24h window).
   - SnapshotRow and leaderboard_snapshot gain uptime_24h (migration 0017,
     gated MIN_SAMPLES.w24h like uptime_7d). Writer upsert extended.
   - API snapshot path selects and maps it; live fallback maps it when its
     queries carry 24h success data, else null (shape parity, honest null).
   - LeaderboardRow gains uptime_24h; frontend adds a Rel 24h column next to
     the existing 7d uptime column; hook and OpenAPI row schema extended.
4. Snapshot speed coverage (completes e04s02): SNAPSHOT_BENCHMARKS gains speed
   so speed probes get snapshot rows, sparkline history, and model pages.
   Existing snapshot tests updated for three rows per model.

## Tests

- test/intelligence.test.ts (new): alias hits incl. -free and :free variants,
  unknown ids return null, thinking OR-merge, reasoningModel false wins,
  every entry has url plus score in sane ranges.
- test/snapshot.test.ts: uptime_24h gating (below MIN_SAMPLES.w24h maps to null),
  speed benchmark rows built.
- test/api.test.ts or leaderboard-adjacent: row carries uptime_24h key.

## Rollback

Each commit revertible via git revert. Migration 0017 is additive (nullable column);
inserts tolerate absence via the existing snapshot try/catch warn-and-skip path.
