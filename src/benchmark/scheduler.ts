import { discoverAll } from "../providers";
import { ensureProvider, upsertModel, markMissingInactive, insertBenchmarkRun } from "../db/queries";
import { getConcurrency } from "../utils/concurrency";
import type { BenchmarkType, Env } from "../types";
import { WORKLOADS } from "./workloads";
import { providerFor } from "../providers/index";

// Queue message shape
export interface BenchJob {
  model_id: number;
  provider: string; // ProviderName widened for new providers
  provider_model_id: string;
  benchmark_type: BenchmarkType;
  display_name: string;
}

export async function runDiscovery(env: Env): Promise<{ discovered: number; added: string[] }> {
  const now = new Date().toISOString();
  const all = await discoverAll(env);
  const byProvider = new Map<string, typeof all>();
  for (const m of all) {
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }
  let total = 0;
  const added: string[] = [];
  for (const [pname, metas] of byProvider) {
    const pid = await ensureProvider(env.DB, pname as import("../types").ProviderName);
    const seen = new Set<string>();
    for (const meta of metas) {
      seen.add(meta.provider_model_id);
      const existed = await env.DB.prepare("SELECT 1 FROM models WHERE provider_id=? AND provider_model_id=?")
        .bind(pid, meta.provider_model_id)
        .first();
      const id = await upsertModel(env.DB, pid, meta, now);
      if (!existed) added.push(`${pname}:${meta.provider_model_id}`);
      total++;
    }
    await markMissingInactive(env.DB, pid, seen, now);
  }
  return { discovered: total, added };
}

export async function scheduleBenchmarks(env: Env): Promise<{ enqueued: number }> {
  const concurrency = getConcurrency(env as unknown as Record<string, unknown>);
  // Single batched query — no N+1 loop (previously fetched ids then re-queried per model)
  const active = await env.DB.prepare(
    "SELECT m.id, m.display_name, m.provider_model_id, p.name as provider FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.active=1 AND m.free_status='FREE' ORDER BY p.name, m.display_name",
  ).all<{ id: number; display_name: string; provider_model_id: string; provider: string }>();

  // pick models round-robin; each model gets one benchmark_type per cron cycle (rotate)
  const hour = new Date().getUTCHours();
  const benchTypes: BenchmarkType[] = ["short", "medium", "coding"];
  const chosenType: BenchmarkType = benchTypes[hour % 3]!;
  const jobs: BenchJob[] = [];
  // group by provider to enforce caps — dynamic via config map, fallback to proportional share when new provider not in old cap list
  const perProvider: Record<string, number> = {};
  let global = 0;
  const perModelSeen = new Set<string>();
  // Build cap map: supports arbitrary providers via concurrency map or env overrides
  const capMap = concurrency as unknown as Record<string, number>;
  const defaultCap = Math.max(2, Math.floor(concurrency.maxGlobal / 4));
  for (const row of (active.results ?? []) as typeof active.results) {
    if (global >= concurrency.maxGlobal) break;
    // dynamic cap: check per-provider cap else fallback to default share
    let providerCap: number;
    if (row.provider === "opencode_zen") providerCap = concurrency.maxOpencode;
    else if (row.provider === "openrouter") providerCap = concurrency.maxOpenrouter;
    else if (row.provider === "groq") providerCap = concurrency.maxGroq;
    else if (row.provider === "cerebras") providerCap = concurrency.maxCerebras;
    else if (row.provider === "gemini") providerCap = concurrency.maxGemini;
    else if (row.provider === "nvidia") providerCap = concurrency.maxNvidia;
    else if (row.provider === "sambanova") providerCap = concurrency.maxSambanova;
    else if (row.provider === "mistral") providerCap = concurrency.maxMistral;
    else if (row.provider === "agnes_ai") providerCap = concurrency.maxAgnesAi;
    else if (row.provider === "aionlabs") providerCap = concurrency.maxAionlabs;
    else if (row.provider === "kilocode") providerCap = concurrency.maxKilocode;
    else if (row.provider === "glhf") providerCap = concurrency.maxGlhf;
    else if (row.provider === "nscale") providerCap = concurrency.maxNscale;
    else if (row.provider === "speka") providerCap = concurrency.maxSpeka;
    else if (row.provider === "nexaapi") providerCap = concurrency.maxNexaapi;
    else if (row.provider === "orcarouter") providerCap = concurrency.maxOrcarouter;
    else if (row.provider === "ninerouter") providerCap = concurrency.maxNinerouter;
    else if (row.provider === "tokenrouter") providerCap = concurrency.maxTokenrouter;
    else {
      const key = `max${row.provider.charAt(0).toUpperCase()}${row.provider.slice(1)}`;
      providerCap = capMap[key] ?? defaultCap;
    }
    const cur = perProvider[row.provider] ?? 0;
    if (cur >= providerCap) continue;
    const key = row.provider + ":" + row.provider_model_id;
    if (perModelSeen.has(key)) continue;
    perModelSeen.add(key);
    jobs.push({
      model_id: row.id,
      provider: row.provider,
      provider_model_id: row.provider_model_id,
      benchmark_type: chosenType,
      display_name: row.display_name,
    });
    perProvider[row.provider] = cur + 1;
    global++;
  }

  // enqueue in batches of 10
  let enqueued = 0;
  for (let i = 0; i < jobs.length; i += 10) {
    const batch = jobs.slice(i, i + 10);
    try {
      await env.BENCH_QUEUE.sendBatch(batch.map((j) => ({ body: j })));
      enqueued += batch.length;
    } catch (e) {
      console.error("queue sendBatch", e);
    }
  }
  return { enqueued };
}

export async function handleBenchJob(env: Env, job: BenchJob): Promise<void> {
  const workload = WORKLOADS[job.benchmark_type];
  const prov = providerFor(job.provider, env);
  if (!prov) return;
  // fetch model row for benchmark
  const mrow = await env.DB.prepare("SELECT * FROM models WHERE id=?").bind(job.model_id).first();
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
  let result: import("../types").BenchmarkResult;
  try {
    result = await prov.benchmarkModel(model as unknown as import("../types").Model, workload);
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
      status: "UNKNOWN_ERROR" as const,
      error_type: msg.slice(0, 500),
      http_status: null,
      provider: job.provider as import("../types").ProviderName,
      model: job.provider_model_id,
      benchmark_type: job.benchmark_type,
      token_estimation_method: "heuristic" as const,
    };
  }
  await insertBenchmarkRun(env.DB, job.model_id, result as import("../types").BenchmarkResult);
  // handle incident detection
  await updateIncidents(env, job.model_id, result as unknown as { status: string; request_started_at: string; error_type?: string | null });
  // broadcast via DO
  try {
    const stub = env.LIVE_DO.get(env.LIVE_DO.idFromName("global"));
    await stub.fetch("https://live/publish", {
      method: "POST",
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
  } catch {}
}

async function updateIncidents(env: Env, modelId: number, result: { status: string; request_started_at: string; error_type?: string | null }) {
  const threshold = Number(env.INCIDENT_THRESHOLD) || 3;
  // fetch recent statuses
  const recent = await env.DB.prepare("SELECT status FROM benchmark_runs WHERE model_id=? ORDER BY started_at DESC LIMIT ?")
    .bind(modelId, threshold)
    .all<{ status: string }>();
  const vals = (recent.results ?? []).map((r) => r.status);
  const isFail = result.status !== "SUCCESS";
  // check if we have streak
  const failStreak = vals.filter((s) => s !== "SUCCESS").length;
  const open = await env.DB.prepare("SELECT id FROM availability_incidents WHERE model_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
    .bind(modelId)
    .first<{ id: number }>();
  if (isFail && failStreak >= threshold && !open) {
    await env.DB.prepare("INSERT INTO availability_incidents (model_id, started_at, reason, failure_count) VALUES (?,?,?,?)")
      .bind(modelId, result.request_started_at, result.error_type ?? result.status, failStreak)
      .run();
  } else if (!isFail && open) {
    const inc = await env.DB.prepare("SELECT started_at FROM availability_incidents WHERE id=?").bind(open.id).first<{ started_at: string }>();
    if (inc) {
      const dur = Math.max(0, Math.round((new Date(result.request_started_at).getTime() - new Date(inc.started_at).getTime()) / 1000));
      await env.DB.prepare("UPDATE availability_incidents SET ended_at=?, duration_seconds=?, failure_count=failure_count+1 WHERE id=?")
        .bind(result.request_started_at, dur, open.id)
        .run();
    }
  } else if (open && isFail) {
    await env.DB.prepare("UPDATE availability_incidents SET failure_count=failure_count+1 WHERE id=?").bind(open.id).run();
  }
}
