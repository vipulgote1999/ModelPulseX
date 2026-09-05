import { discoverAll } from "../providers";
import {
  ensureProvidersBatch,
  upsertModelsBatch,
  markMissingInactive,
  insertBenchmarkRun,
} from "../db/queries";
import { applyDataFixes } from "../db/data-fixes";
import { recordScheduleTick } from "../db/health";
import {
  getConcurrency,
  capFor,
  getRPMConfig,
  rpmForProvider,
} from "../utils/concurrency";
import {
  selectJobs,
  type QueueJob,
  type SelectableModel,
} from "../utils/scheduler-select";
import type { BenchmarkType, Env, ProviderName } from "../types";
import { WORKLOADS } from "./workloads";
import { providerFor } from "../providers/index";
import { freeHardFilterWhere } from "../providers/registry";
import {
  setProviderCooldown,
  setModelCooldown,
  clearModelCooldown,
  escalateProviderCooldown,
} from "../db/cooldown";

// Queue message shape — identical to the pure selector's QueueJob.
export type BenchJob = QueueJob;

export async function runDiscovery(
  env: Env,
): Promise<{ discovered: number; added: string[]; fixesApplied?: string[] }> {
  const now = new Date().toISOString();
  const all = await discoverAll(env);
  const byProvider = new Map<string, typeof all>();
  for (const m of all) {
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }
  // Batch ensure providers — single batch for all providers (reduces I/O from N to 1)
  const providerNames = Array.from(byProvider.keys()) as ProviderName[];
  const providerMap = await ensureProvidersBatch(env.DB, providerNames);
  let total = 0;
  const added: string[] = [];
  // Snapshot existing models once to detect "added" without per-model SELECT
  const existingRows = await env.DB.prepare(
    `SELECT provider_id, provider_model_id FROM models WHERE active=1`,
  ).all<{ provider_id: number; provider_model_id: string }>();
  const existingSet = new Set<string>();
  for (const r of existingRows.results ?? [])
    existingSet.add(`${r.provider_id}:${r.provider_model_id}`);
  for (const [pname, metas] of byProvider) {
    const pid = providerMap.get(pname)!;
    const seen = new Set<string>();
    for (const meta of metas) seen.add(meta.provider_model_id);
    // Batch upsert — N models in ceil(N/50) roundtrips instead of N*2
    await upsertModelsBatch(env.DB, pid, metas, now);
    for (const meta of metas) {
      const key = `${pid}:${meta.provider_model_id}`;
      if (!existingSet.has(key))
        added.push(`${pname}:${meta.provider_model_id}`);
      total++;
    }
    await markMissingInactive(env.DB, pid, seen, now);
  }
  // One-shot guarded data fixes (tokenrouter paid purge, ollama allowlist) — replaces the
  // hardcoded cleanups that previously ran on EVERY discovery cycle.
  let fixesApplied: string[] = [];
  try {
    fixesApplied = await applyDataFixes(env.DB);
  } catch (e) {
    console.warn("data fixes", e);
  }
  return { discovered: total, added, fixesApplied };
}

export async function scheduleBenchmarks(
  env: Env,
  opts: { inlineTake?: number } = {},
): Promise<{
  enqueued: number;
  inlineRan: number;
  skippedCooldown: number;
  skippedRPM: number;
  selected: number;
}> {
  // SAFETY: Env carries provider config as string-typed vars plus an index signature;
  // getConcurrency/getRPMConfig only read string keys and ignore the D1/Queue/DO bindings.
  const concurrency = getConcurrency(env as unknown as Record<string, unknown>);
  // SAFETY: rpmConfig reads only string env vars (RPM_*/MAX_*_RPM); bindings are ignored.
  const rpmConfig = getRPMConfig(env as unknown as Record<string, unknown>);
  const nowIso = new Date().toISOString();
  const hour = new Date().getUTCHours();
  const benchTypes: BenchmarkType[] = ["short", "medium", "coding"];
  const chosenType: BenchmarkType = benchTypes[hour % 3]!;

  // Smart rotation: order models by least-recently-benchmarked (LRU) so we hit different models each cycle.
  // Rows-read fix: LRU comes from maintained models.last_benchmark_at (migration 0011,
  // stamped by insertBenchmarkRun) — an indexed models-only read (~150 rows) instead of
  // LEFT JOIN + GROUP BY over all of benchmark_runs every 5 min (~9k rows × 288 ticks/day).
  // Respects admin per-model toggle: benchmark_enabled=1 (keep all models stored, disabled ones skip queue)
  let active: { results?: SelectableModel[] };
  try {
    active = await env.DB.prepare(
      `SELECT m.id, m.display_name, m.provider_model_id, p.name as provider, m.last_benchmark_at as last_benchmark
       FROM models m JOIN providers p ON p.id=m.provider_id
       WHERE m.active=1 AND COALESCE(m.benchmark_enabled,1)=1 AND m.free_status='FREE'${freeHardFilterWhere("p", "m")}
       ORDER BY m.last_benchmark_at ASC NULLS FIRST, p.name, m.display_name`,
    ).all<SelectableModel>();
  } catch (e) {
    const msg = String(e);
    if (msg.includes("benchmark_enabled") || msg.includes("last_benchmark_at") || msg.includes("no such column")) {
      active = await env.DB.prepare(
        `SELECT m.id, m.display_name, m.provider_model_id, p.name as provider, MAX(br.started_at) as last_benchmark
         FROM models m JOIN providers p ON p.id=m.provider_id
         LEFT JOIN benchmark_runs br ON br.model_id=m.id
         WHERE m.active=1 AND m.free_status='FREE'${freeHardFilterWhere("p", "m")}
         GROUP BY m.id
         ORDER BY last_benchmark ASC, p.name, m.display_name`,
      ).all<SelectableModel>();
    } else throw e;
  }

  // Prefetch cooldowns and RPM usage in parallel — tolerant to missing tables pre-migration.
  // NOTE: cutoff MUST be a JS-computed ISO string. SQLite datetime('now','-60 seconds')
  // yields 'YYYY-MM-DD HH:MM:SS' which string-compares BELOW ISO-'T' timestamps, silently
  // widening the 60s window to "since UTC midnight" and tripping RPM limits by early morning
  // (root cause of the recurring daily benchmark stalls).
  const rpmSinceIso = new Date(Date.now() - 60_000).toISOString();
  const [providerCooldowns, modelCooldowns, rpmUsage] = await Promise.all([
    env.DB.prepare(
      `SELECT provider, cooldown_until FROM provider_cooldowns WHERE cooldown_until > ?`,
    )
      .bind(nowIso)
      .all<{ provider: string }>()
      .catch(() => ({ results: [] as Array<{ provider: string }> })),
    env.DB.prepare(
      `SELECT model_id FROM model_cooldowns WHERE cooldown_until > ?`,
    )
      .bind(nowIso)
      .all<{ model_id: number }>()
      .catch(() => ({ results: [] as Array<{ model_id: number }> })),
    env.DB.prepare(
      `SELECT provider, COUNT(*) as cnt FROM benchmark_runs WHERE started_at >= ? GROUP BY provider`,
    )
      .bind(rpmSinceIso)
      .all<{ provider: string; cnt: number }>()
      .catch(() => ({
        results: [] as Array<{ provider: string; cnt: number }>,
      })),
  ]);
  const providerCooldownSet = new Set(
    (providerCooldowns.results ?? []).map((r) => r.provider),
  );
  const modelCooldownSet = new Set(
    (modelCooldowns.results ?? []).map((r) => r.model_id),
  );
  const rpmUsageMap = new Map(
    (rpmUsage.results ?? []).map((r) => [r.provider, r.cnt] as const),
  );

  const { jobs, skippedCooldown, skippedRPM } = selectJobs(
    active.results ?? [],
    {
      maxGlobal: concurrency.maxGlobal,
      capFor: (p) => capFor(p, concurrency),
      rpmLimitFor: (p) => rpmForProvider(p, rpmConfig),
      providerCooldowns: providerCooldownSet,
      modelCooldowns: modelCooldownSet,
      rpmUsage: rpmUsageMap,
      benchmarkType: chosenType,
    },
  );

  // Inline fallback: execute the first N selected jobs inside this cron invocation so
  // baseline coverage survives even if queue delivery stalls (observed in prod Aug 2025).
  const inlineTake = Math.max(0, Math.min(opts.inlineTake ?? 0, jobs.length));
  let inlineRan = 0;
  for (const job of jobs.slice(0, inlineTake)) {
    try {
      await handleBenchJob(env, job);
      inlineRan++;
    } catch (e) {
      console.error("inline bench job failed", job.model_id, e);
    }
  }

  // Enqueue the remainder in batches of 10
  let enqueued = 0;
  const rest = jobs.slice(inlineTake);
  for (let i = 0; i < rest.length; i += 10) {
    const batch = rest.slice(i, i + 10);
    try {
      await env.BENCH_QUEUE.sendBatch(batch.map((j) => ({ body: j })));
      enqueued += batch.length;
    } catch (e) {
      console.error("queue sendBatch", e);
    }
  }

  // Heartbeat: make enqueue health observable via /api/leaderboard meta + /api/health.
  await recordScheduleTick(env.DB, {
    enqueueCount: enqueued,
    inlineCount: inlineRan,
    skippedCooldown,
    skippedRpm: skippedRPM,
  });

  return {
    enqueued,
    inlineRan,
    skippedCooldown,
    skippedRPM,
    selected: jobs.length,
  };
}

export async function handleBenchJob(env: Env, job: QueueJob): Promise<void> {
  const workload = WORKLOADS[job.benchmark_type as BenchmarkType];
  const prov = providerFor(job.provider, env);
  if (!prov) return;
  // fetch model row for benchmark
  const mrow = await env.DB.prepare("SELECT * FROM models WHERE id=?")
    .bind(job.model_id)
    .first();
  if (!mrow) return;
  const model = {
    id: job.model_id,
    provider: job.provider,
    provider_model_id: job.provider_model_id,
    display_name: job.display_name,
    provider_id: 0,
    active: true,
    free_status: "FREE" as const,
    context_length: null,
    capabilities: [] as string[],
    input_price: null,
    output_price: null,
    first_seen: "",
    last_seen: "",
  };
  // SAFETY: the object satisfies Model structurally — jobs carry provider by name, so
  // provider_id is an unused placeholder (0) here.
  let result: import("../types").BenchmarkResult;
  try {
    // SAFETY: object satisfies Model structurally — provider_id is an unused placeholder (0)
    // because jobs identify providers by name.
    result = await prov.benchmarkModel(
      model as unknown as import("../types").Model,
      workload,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = {
      request_started_at: new Date().toISOString(),
      first_token_at: null,
      request_completed_at: null,
      input_tokens: null,
      output_tokens: null,
      ttft_ms: null,
      generation_ms: null,
      tps: null,
      itl_ms: null,
      chunk_count: null,
      status: "UNKNOWN_ERROR" as const,
      error_type: msg.slice(0, 500),
      http_status: null,
      provider: job.provider as import("../types").ProviderName,
      model: job.provider_model_id,
      benchmark_type: job.benchmark_type as BenchmarkType,
      token_estimation_method: "heuristic" as const,
    };
  }
  await insertBenchmarkRun(
    env.DB,
    job.model_id,
    result as import("../types").BenchmarkResult,
  );
  // --- Cooldown handling: distinguish model-specific vs provider-wide failure ---
  try {
    const status = result.status;
    const http = result.http_status ?? null;
    const err = (result.error_type ?? "").toLowerCase();
    const cooldownMaxMs = Number(env.COOLDOWN_MAX_MS) || 2 * 60 * 60 * 1000;
    if (status === "SUCCESS") {
      // Success clears model cooldown (model recovered); provider cooldown persists until expiry or manual reset
      await clearModelCooldown(env.DB, job.model_id);
    } else if (
      status === "RATE_LIMITED" ||
      http === 429 ||
      err.includes("rate limit") ||
      err.includes("too many requests")
    ) {
      // Provider refusing — escalating provider-wide cooldown honoring Retry-After when present
      const retryMs = result.retry_after_ms ?? 60_000;
      await escalateProviderCooldown(
        env.DB,
        job.provider,
        retryMs,
        `RATE_LIMITED ${result.error_type ?? "429"}`.slice(0, 500),
        cooldownMaxMs,
      );
      // Also brief model cooldown to avoid immediate retry of same model
      await setModelCooldown(env.DB, job.model_id, 30_000, `RATE_LIMITED`);
    } else if (status === "MODEL_UNAVAILABLE" || http === 404) {
      // Model-specific: model doesn't exist or not available — cooldown only this model (10m)
      await setModelCooldown(
        env.DB,
        job.model_id,
        10 * 60 * 1000,
        `MODEL_UNAVAILABLE ${result.error_type ?? "404"}`,
      );
    } else if (status === "TIMEOUT") {
      // Timeout is model-specific (model slow), not provider — short model cooldown (2m)
      await setModelCooldown(env.DB, job.model_id, 2 * 60 * 1000, `TIMEOUT`);
    } else if (
      err.includes("insufficient") ||
      err.includes("quota") ||
      err.includes("credit") ||
      err.includes("balance") ||
      err.includes("recharge")
    ) {
      // Quota/balance errors are provider-wide (account level) — escalating cooldown so dead
      // keys stop re-burning benchmark capacity every few minutes
      await escalateProviderCooldown(
        env.DB,
        job.provider,
        15 * 60 * 1000,
        `QUOTA_EXCEEDED ${result.error_type ?? ""}`.slice(0, 500),
        cooldownMaxMs,
      );
      await setModelCooldown(
        env.DB,
        job.model_id,
        5 * 60 * 1000,
        `QUOTA_EXCEEDED`,
      );
    } else if (status === "PROVIDER_ERROR" && http != null && http >= 500) {
      if (err.includes("model") || err.includes("not found")) {
        await setModelCooldown(
          env.DB,
          job.model_id,
          5 * 60 * 1000,
          `PROVIDER_ERROR model-specific 5xx`,
        );
      } else {
        await setProviderCooldown(
          env.DB,
          job.provider,
          30_000,
          `PROVIDER_ERROR 5xx`,
        );
        await setModelCooldown(
          env.DB,
          job.model_id,
          30_000,
          `PROVIDER_ERROR 5xx`,
        );
      }
    } else if (status === "STREAM_ERROR" || status === "PROVIDER_ERROR") {
      await setModelCooldown(
        env.DB,
        job.model_id,
        3 * 60 * 1000,
        `${status} ${result.error_type ?? ""}`.slice(0, 500),
      );
    }
  } catch (e) {
    console.warn("cooldown handling", e);
  }
  // handle incident detection
  // SAFETY: BenchmarkResult is a superset of this narrow view — updateIncidents only reads
  // status/request_started_at/error_type.
  await updateIncidents(
    env,
    job.model_id,
    result as unknown as {
      status: string;
      request_started_at: string;
      error_type?: string | null;
    },
  );
  // broadcast via DO
  try {
    const stub = env.LIVE_DO.get(env.LIVE_DO.idFromName("global"));
    await stub.fetch("https://live/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mpulse-internal": "1" },
      body: JSON.stringify({
        type: "benchmark.completed",
        model: job.provider_model_id,
        provider: job.provider,
        tps: result.tps,
        ttft_ms: result.ttft_ms,
        status: result.status,
        benchmark_type: job.benchmark_type,
        timestamp: result.request_started_at,
      }),
    });
  } catch (e) {
    // Best-effort live broadcast — a DO outage must never fail the benchmark result itself.
    console.warn("live publish", e);
  }
}

async function updateIncidents(
  env: Env,
  modelId: number,
  result: {
    status: string;
    request_started_at: string;
    error_type?: string | null;
  },
) {
  const threshold = Number(env.INCIDENT_THRESHOLD) || 3;
  // fetch recent statuses
  const recent = await env.DB.prepare(
    "SELECT status FROM benchmark_runs WHERE model_id=? ORDER BY started_at DESC LIMIT ?",
  )
    .bind(modelId, threshold)
    .all<{ status: string }>();
  const vals = (recent.results ?? []).map((r) => r.status);
  const isFail = result.status !== "SUCCESS";
  // check if we have streak
  const failStreak = vals.filter((s) => s !== "SUCCESS").length;
  const open = await env.DB.prepare(
    "SELECT id FROM availability_incidents WHERE model_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
  )
    .bind(modelId)
    .first<{ id: number }>();
  if (isFail && failStreak >= threshold && !open) {
    await env.DB.prepare(
      "INSERT INTO availability_incidents (model_id, started_at, reason, failure_count) VALUES (?,?,?,?)",
    )
      .bind(
        modelId,
        result.request_started_at,
        result.error_type ?? result.status,
        failStreak,
      )
      .run();
  } else if (!isFail && open) {
    const inc = await env.DB.prepare(
      "SELECT started_at FROM availability_incidents WHERE id=?",
    )
      .bind(open.id)
      .first<{ started_at: string }>();
    if (inc) {
      const dur = Math.max(
        0,
        Math.round(
          (new Date(result.request_started_at).getTime() -
            new Date(inc.started_at).getTime()) /
            1000,
        ),
      );
      await env.DB.prepare(
        "UPDATE availability_incidents SET ended_at=?, duration_seconds=?, failure_count=failure_count+1 WHERE id=?",
      )
        .bind(result.request_started_at, dur, open.id)
        .run();
    }
  } else if (open && isFail) {
    await env.DB.prepare(
      "UPDATE availability_incidents SET failure_count=failure_count+1 WHERE id=?",
    )
      .bind(open.id)
      .run();
  }
}
