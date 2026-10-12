# e04s02 - OpenCode Go plus Ollama tiers plus per-tier cadence plus speed rotation

Source: opencode.ai/docs/go (fetched 2026-10-12) plus TokenDyno methodology and pricing plus overview API (round 1) plus repo conventions.

## Researched facts

- Go endpoints (same family as Zen): opencode.ai/zen/go/v1/models and opencode.ai/zen/go/v1/chat/completions.
  The responses and messages variants are out of scope: the engine speaks OpenAI chat completions only (noted as future).
- Go plans: 10/mo Go and 40/mo Go Plus; per-model monthly dollar limits; windows 20 percent per 5h, 50 percent per week, 100 percent per month.
- Only two Go models are marked Free (limited time): LongCat 2.5 Preview and Step 5 Preview.
- Go client rules: own User-Agent (not a generic SDK name), stable x-opencode-session per conversation.
  Each benchmark run IS its own conversation, so the e04s01 fresh-per-run session id complies.
- TokenDyno tiers observed: opencode-go, opencode-go-responses, opencode-go-anthropic, opencode-zen-responses, ollama, ollama-free, opencode-zen.
- TokenDyno cadence: Pro about 10m, Free and Zen about 60m, Go standard about 30m, priciest Go about 6h.
- TokenDyno Go free models observed: step-5-preview-free and longcat-2.5-preview-free (both -free suffixed).

## Design (convention-compliant)

1. opencode_go adapter (src/providers/opencode-go.ts):
   - Discovery GETs zen/go/v1/models with OPENCODE_GO_API_KEY; tolerant shapes (Zen-style and OpenAI-style data arrays).
   - Free rule: id ends with -free (covers both documented limited-time free models) maps to FREE; else UNKNOWN.
     UNKNOWN skips the verifyFree queue gate per conventions. No fallback catalog: without a key or on API
     error discovery returns an empty list (never fabricate on a paid gateway).
   - slow-cadence capability tag for priciest ids (documented from TokenDyno 6h policy; adjustable) maps to 360m cadence vs 30m standard.
   - Honest UA modelpulsex/1.0; the engine default already sends a fresh x-opencode-session per run.
   - Registry: no hardFreeFilter (suffix-only SQL would hide future free ids) so an ACCEPTED_FILTER_GAPS entry is added.
   - Default-disabled via DISABLED_PROVIDER_DEFAULT: subscription catalog is stored, never auto-queued; admin enables per model.
2. Ollama tier split: OllamaProvider parameterized by tier. ollama unchanged (free allowlist, 60m).
   New ollama_pro descriptor: full catalog discovery, allowlist ids map to FREE else PAID; key OLLAMA_PRO_API_KEY with fallback to OLLAMA_API_KEY.
   Default-disabled plus gap entry. Same-model cross-tier comparison (Pro vs Free) falls out.
3. Per-tier cadence (spend control, never affects measurement):
   - ProviderDescriptor.cadenceMinutes, optional. Undefined means unchanged LRU-only behavior (zero regression risk for the other 17 providers).
   - Values: ollama 60, ollama_pro 10, opencode_zen 60, opencode_go 30 (slow-cadence capability maps to 360).
   - selectJobs gains pure min-interval enforcement: optional SelectableModel.capabilities, cfg nowMs plus
     tierIntervalMsFor(provider, capabilities), result skippedCadence. Unparseable last_benchmark never skips (treat as stale).
   - Scheduler builds the callback from the registry; SQL also selects m.capabilities (primary plus fallback paths).
4. Speed-probe rotation: second selectJobs pass per tick with benchmarkType speed, models ordered by per-type last run
   from last_now_json speed.at; take SPEED_PROBE_TAKE (default 3, env-overridable). RPM and cap budgets offset by
   coding-taken jobs via pure withUsageOffset helper. Pre-0012 DBs (no last_now_json) skip speed probes via the existing catch path.
5. Config: Env gains OPENCODE_GO_API_KEY, OLLAMA_PRO_API_KEY, SPEED_PROBE_TAKE; concurrency and RPM keys
   MAX_OPENCODE_GO_CONCURRENCY and MAX_OLLAMA_PRO_CONCURRENCY (RPM overrides by convention); wrangler vars plus secret comments.

## Tests (TDD)

- discovery.test.ts: Go free-suffix maps to FREE else UNKNOWN; no-key maps to empty list; slow-cadence tag; pro tier allowlist maps to FREE else PAID.
- provider-registry.test.ts: new descriptors resolve; gap entries cover filter-less providers (existing guard extends automatically).
- provider-limits.test.ts: new concurrency and RPM keys resolve plus caps.
- scheduler-select.test.ts: min-interval skips fresh models (counts skippedCadence), honors slow-cadence capability,
  unparseable timestamps never skip; withUsageOffset deducts taken jobs.

## Rollback

Each commit revertible via git revert; new providers are additive rows plus registry entries
(disable via admin toggle or env, no migration needed). No migration in this story (uses existing columns only).
