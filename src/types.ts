/** Shared types — single source for API, DB, provider, and frontend. */

export type ProviderName =
 | "opencode_zen"
 | "openrouter"
 | "groq"
 | "cerebras"
 | "gemini"
 | "nvidia"
 | "sambanova"
 | "mistral"
 | "cloudflare"
 | "agnes_ai"
 | "aionlabs"
 | "kilocode"
 | "glhf"
 | "nscale"
 | "speka"
 | "nexaapi"
 | "orcarouter"
 | "ninerouter"
 | "tokenrouter"
 | "ollama";
export type FreeStatus = "FREE" | "PAID" | "UNKNOWN" | "PREVIOUSLY_FREE";
export type BenchmarkType = "short" | "medium" | "coding";
export type BenchmarkStatus =
 | "SUCCESS"
 | "TIMEOUT"
 | "RATE_LIMITED"
 | "PROVIDER_ERROR"
 | "MODEL_UNAVAILABLE"
 | "STREAM_ERROR"
 | "UNKNOWN_ERROR";

export interface ProviderRow {
 id: number;
 name: string; // e.g., opencode_zen
 type: string;
 enabled: number;
 created_at: string;
}

export interface ModelRow {
 id: number;
 provider_id: number;
 provider_model_id: string;
 name: string;
 display_name: string;
 is_free: number;
 free_status: FreeStatus;
 context_length: number | null;
 capabilities: string | null;
 input_price: string | null;
 output_price: string | null;
 first_seen: string;
 last_seen: string;
 active: number;
 benchmark_enabled?: number | null;
}

export interface Model {
 id: number;
 provider: ProviderName;
 provider_model_id: string;
 display_name: string;
 context_length: number | null;
 capabilities: string[];
 input_price: string | null;
 output_price: string | null;
 free_status: FreeStatus;
 active: boolean;
 benchmark_enabled?: boolean;
 first_seen: string;
 last_seen: string;
 provider_id: number;
}

export interface BenchmarkDefinition {
 type: BenchmarkType;
 prompt: string;
 max_tokens: number;
 timeout_ms: number;
}

export interface BenchmarkResult {
 request_started_at: string;
 first_token_at: string | null;
 request_completed_at: string | null;
 input_tokens: number | null;
 output_tokens: number | null;
 ttft_ms: number | null;
 generation_ms: number | null;
 tps: number | null;
 status: BenchmarkStatus;
 error_type: string | null;
 http_status: number | null;
 provider: ProviderName;
 model: string; // provider_model_id echoed
 benchmark_type: BenchmarkType;
 token_estimation_method: "provider" | "heuristic";
 /** Provider-supplied Retry-After (ms) when status is RATE_LIMITED; null otherwise. */
 retry_after_ms?: number | null;
}

export interface LLMProvider {
 getProviderName(): ProviderName;
 discoverModels(): Promise<ModelMetadata[]>;
 getModelMetadata(modelId: string): Promise<ModelMetadata | null>;
 benchmarkModel(
  model: Model,
  benchmark: BenchmarkDefinition,
 ): Promise<BenchmarkResult>;
}

export interface ModelMetadata {
 provider: ProviderName;
 provider_model_id: string;
 display_name: string;
 context_length: number | null;
 capabilities: string[];
 input_price: string | null;
 output_price: string | null;
 is_free: boolean;
 free_status: FreeStatus;
}

/** Scheduler heartbeat persisted every 5-minute cron tick — makes enqueue health observable. */
export interface SchedulerHealth {
 last_schedule_at: string | null;
 last_enqueue_count: number;
 last_inline_count: number;
 last_skipped_cooldown: number;
 last_skipped_rpm: number;
 last_discovery_at: string | null;
 last_aggregate_at: string | null;
 last_stale_alert_at: string | null;
}

export interface LeaderboardRow {
 rank: number;
 model_id: number;
 model: string;
 display_name: string;
 provider: ProviderName;
 free_status: FreeStatus;
 active: boolean;
 tps_now: number | null;
 tps_1h: number | null;
 tps_24h: number | null;
 tps_7d: number | null;
 ttft_now: number | null;
 ttft_1h: number | null;
 ttft_24h: number | null;
 ttft_7d: number | null;
 uptime_7d: number | null;
 error_rate_7d: number | null;
 success_rate: number | null;
 status: BenchmarkStatus | "UNKNOWN";
 last_test: string | null;
 request_count_7d: number;
 overall_score: number | null;
 /** Recent hourly TPS trend (≤24 points, oldest→newest). */
 sparkline?: Array<number | null>;
 /** Raw benchmark count in the last 24h — context for metric trustworthiness. */
 sampleCount24h?: number;
 /** Display label for the primary TPS figure (median-based). */
 measured_tps_label?: string;
 /** True when the model was free recently but its provider stopped offering it free. */
 previously_free?: boolean;
}

export interface HistoryPoint {
 hour_start: string;
 benchmark_type: BenchmarkType;
 avg_tps: number | null;
 median_tps: number | null;
 p90_tps: number | null;
 p95_tps: number | null;
 avg_ttft: number | null;
 median_ttft: number | null;
 p90_ttft: number | null;
 p95_ttft: number | null;
 success_rate: number | null;
 uptime: number | null;
 request_count: number;
}

export interface IncidentRow {
 id: number;
 model_id: number;
 started_at: string;
 ended_at: string | null;
 duration_seconds: number | null;
 reason: string | null;
 failure_count: number;
}

export interface CompareEntry {
 provider: ProviderName;
 model: string;
 tps_24h: number | null;
 tps_7d: number | null;
 ttft_24h: number | null;
 ttft_7d: number | null;
 uptime_7d: number | null;
 error_rate: number | null;
 request_count_7d: number;
 winner?: boolean;
}

export interface ScoringProfile {
 id: string;
 label: string;
 weights: {
  tps: number;
  ttft: number;
  reliability: number;
  consistency: number;
 };
}

export const SCORING_PROFILES: ScoringProfile[] = [
 {
  id: "balanced",
  label: "Balanced",
  weights: { tps: 0.4, ttft: 0.25, reliability: 0.25, consistency: 0.1 },
 },
 {
  id: "fastest",
  label: "Fastest",
  weights: { tps: 0.6, ttft: 0.15, reliability: 0.15, consistency: 0.1 },
 },
 {
  id: "latency",
  label: "Lowest Latency",
  weights: { tps: 0.2, ttft: 0.5, reliability: 0.2, consistency: 0.1 },
 },
 {
  id: "reliable",
  label: "Most Reliable",
  weights: { tps: 0.2, ttft: 0.15, reliability: 0.55, consistency: 0.1 },
 },
 {
  id: "coding",
  label: "Coding",
  weights: { tps: 0.35, ttft: 0.15, reliability: 0.3, consistency: 0.2 },
 },
];

export interface Env {
 DB: D1Database;
 BENCH_QUEUE: Queue;
 LIVE_DO: DurableObjectNamespace;
 OPENCODE_API_KEY?: string;
 OPENROUTER_API_KEY?: string;
 GROQ_API_KEY?: string;
 CEREBRAS_API_KEY?: string;
 GEMINI_API_KEY?: string;
 NVIDIA_API_KEY?: string;
 SAMBANOVA_API_KEY?: string;
 MISTRAL_API_KEY?: string;
 AGNES_API_KEY?: string;
 AIONLABS_API_KEY?: string;
 KILOCODE_API_KEY?: string;
 GLHF_API_KEY?: string;
 NSCALE_API_KEY?: string;
 SPEKA_API_KEY?: string;
 NEXAAPI_API_KEY?: string;
 ORCAROUTER_API_KEY?: string;
 NINEROUTER_API_KEY?: string;
 TOKENROUTER_API_KEY?: string;
 OLLAMA_API_KEY?: string;
 ADMIN_TOKEN?: string;
 ADMIN_ID?: string;
 ADMIN_USERNAME?: string;
 ADMIN_PASSWORD?: string;
 CORS_ORIGIN?: string;
 /** Optional webhook (Discord/Slack-compatible {content,text} body) notified when the
  *  pipeline goes stale or recovers. Set via `wrangler secret put ALERT_WEBHOOK_URL`. */
 ALERT_WEBHOOK_URL?: string;
 /** Minutes after which a missing fresh measurement counts as STALE for watchdog/probe (default 30). */
 STALE_ALERT_MINUTES?: string;
 /** Number of selected jobs executed inline inside the 5-minute cron invocation as a queue-delivery
  *  fallback (default 6; 0 disables). Guarantees baseline coverage even if queue delivery stalls. */
 BENCH_INLINE_FALLBACK?: string;
 /** Upper bound (ms) for escalating provider cooldowns (default 2h). */
 COOLDOWN_MAX_MS?: string;
 MAX_GLOBAL_CONCURRENCY?: string;
 MAX_OPENCODE_CONCURRENCY?: string;
 MAX_OPENROUTER_CONCURRENCY?: string;
 MAX_GROQ_CONCURRENCY?: string;
 MAX_CEREBRAS_CONCURRENCY?: string;
 MAX_GEMINI_CONCURRENCY?: string;
 MAX_NVIDIA_CONCURRENCY?: string;
 MAX_SAMBANOVA_CONCURRENCY?: string;
 MAX_MISTRAL_CONCURRENCY?: string;
 MAX_AGNES_AI_CONCURRENCY?: string;
 MAX_AIONLABS_CONCURRENCY?: string;
 MAX_KILOCODE_CONCURRENCY?: string;
 MAX_GLHF_CONCURRENCY?: string;
 MAX_NSCALE_CONCURRENCY?: string;
 MAX_SPEKA_CONCURRENCY?: string;
 MAX_NEXAAPI_CONCURRENCY?: string;
 MAX_ORCAROUTER_CONCURRENCY?: string;
 MAX_NINEROUTER_CONCURRENCY?: string;
 MAX_TOKENROUTER_CONCURRENCY?: string;
 MAX_OLLAMA_CONCURRENCY?: string;
 MAX_SAME_MODEL_CONCURRENCY?: string;
 BENCHMARK_TIMEOUT_MS?: string;
 INCIDENT_THRESHOLD?: string;
 // allow arbitrary provider concurrency envs
 [key: string]:
  | string
  | D1Database
  | Queue
  | DurableObjectNamespace
  | undefined;
}
