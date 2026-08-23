import { discoverAll } from "../providers";
import { ensureProvidersBatch, upsertModelsBatch, markMissingInactive, insertBenchmarkRun } from "../db/queries";
import { getConcurrency } from "../utils/concurrency";
import type { BenchmarkType, Env, ProviderName } from "../types";
import { WORKLOADS } from "./workloads";
import { providerFor } from "../providers/index";
import { setProviderCooldown, setModelCooldown, clearModelCooldown, clearProviderCooldown } from "../db/cooldown";

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
  // Batch ensure providers — single batch for all providers (reduces I/O from N to 1)
  const providerNames = Array.from(byProvider.keys()) as ProviderName[];
  const providerMap = await ensureProvidersBatch(env.DB, providerNames);
  let total = 0;
  const added: string[] = [];
  // Snapshot existing models once to detect "added" without per-model SELECT
  const existingRows = await env.DB.prepare(`SELECT provider_id, provider_model_id FROM models WHERE active=1`).all<{ provider_id: number; provider_model_id: string }>();
  const existingSet = new Set<string>();
  for (const r of (existingRows.results ?? [])) existingSet.add(`${r.provider_id}:${r.provider_model_id}`);
  for (const [pname, metas] of byProvider) {
    const pid = providerMap.get(pname)!;
    const seen = new Set<string>();
    for (const meta of metas) seen.add(meta.provider_model_id);
    // Batch upsert — N models in ceil(N/50) roundtrips instead of N*2
    await upsertModelsBatch(env.DB, pid, metas, now);
    for (const meta of metas) {
      const key = `${pid}:${meta.provider_model_id}`;
      if (!existingSet.has(key)) added.push(`${pname}:${meta.provider_model_id}`);
      total++;
    }
    await markMissingInactive(env.DB, pid, seen, now);
  }
  // One-time hard cleanup: tokenrouter previously polluted with 147 paid models (not ending with free) — delete them so they never appear (they were never free)
  try {
    const trPid = providerMap.get("tokenrouter");
    if (trPid) {
      await env.DB.prepare(`DELETE FROM benchmark_runs WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free')`).bind(trPid).run();
      await env.DB.prepare(`DELETE FROM hourly_model_stats WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free')`).bind(trPid).run();
      await env.DB.prepare(`DELETE FROM availability_incidents WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free')`).bind(trPid).run();
      await env.DB.prepare(`DELETE FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free'`).bind(trPid).run();
    } else {
      const existing = await env.DB.prepare(`SELECT id FROM providers WHERE name='tokenrouter'`).first<{ id: number }>();
      if (existing) {
        const pid = existing.id;
        await env.DB.prepare(`DELETE FROM benchmark_runs WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free')`).bind(pid).run();
        await env.DB.prepare(`DELETE FROM hourly_model_stats WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free')`).bind(pid).run();
        await env.DB.prepare(`DELETE FROM availability_incidents WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free')`).bind(pid).run();
        await env.DB.prepare(`DELETE FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free'`).bind(pid).run();
      }
    }
  } catch (e) { console.warn("tokenrouter cleanup", e); }
  // Ollama cleanup: keep only verified 7 free models — delete any previously inserted paid/subscription models (glm-5.2, etc)
  try {
    const freeOllama = ["gemma4:31b","minimax-m3","gpt-oss:20b","gpt-oss:120b","nemotron-3-super","nemotron-3-ultra","nemotron-3-nano:30b"];
    const placeholders = freeOllama.map(() => "?").join(",");
    const ollamaPid = providerMap.get("ollama") ?? (await env.DB.prepare(`SELECT id FROM providers WHERE name='ollama'`).first<{ id: number }>() )?.id;
    if (ollamaPid) {
      await env.DB.prepare(`DELETE FROM benchmark_runs WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND provider_model_id NOT IN (${placeholders}))`).bind(ollamaPid, ...freeOllama).run();
      await env.DB.prepare(`DELETE FROM hourly_model_stats WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND provider_model_id NOT IN (${placeholders}))`).bind(ollamaPid, ...freeOllama).run();
      await env.DB.prepare(`DELETE FROM availability_incidents WHERE model_id IN (SELECT id FROM models WHERE provider_id=? AND provider_model_id NOT IN (${placeholders}))`).bind(ollamaPid, ...freeOllama).run();
      await env.DB.prepare(`DELETE FROM models WHERE provider_id=? AND provider_model_id NOT IN (${placeholders})`).bind(ollamaPid, ...freeOllama).run();
    }
  } catch (e) { console.warn("ollama cleanup", e); }
  return { discovered: total, added };
}

export async function scheduleBenchmarks(env: Env): Promise<{ enqueued: number; skippedCooldown?: number; skippedRPM?: number }> {
  const concurrency = getConcurrency(env as unknown as Record<string, unknown>);
  const { getRPMConfig, rpmForProvider } = await import("../utils/concurrency");
  const rpmConfig = getRPMConfig(env as unknown as Record<string, unknown>);
  const nowIso = new Date().toISOString();
  const hour = new Date().getUTCHours();
  const benchTypes: BenchmarkType[] = ["short", "medium", "coding"];
  const chosenType: BenchmarkType = benchTypes[hour % 3]!;

  // Smart rotation: order models by least-recently-benchmarked (LRU) so we hit different models each cycle, not same model repeatedly
  // Uses LEFT JOIN to benchmark_runs to get last_benchmark per model, NULLS FIRST (never-benchmarked first)
  const active = await env.DB.prepare(
    `SELECT m.id, m.display_name, m.provider_model_id, p.name as provider, MAX(br.started_at) as last_benchmark
     FROM models m JOIN providers p ON p.id=m.provider_id
     LEFT JOIN benchmark_runs br ON br.model_id=m.id
     WHERE m.active=1 AND m.free_status='FREE'
       AND (p.name != 'tokenrouter' OR lower(m.provider_model_id) LIKE '%free')
       AND (p.name != 'ollama' OR m.provider_model_id IN ('gemma4:31b','minimax-m3','gpt-oss:20b','gpt-oss:120b','nemotron-3-super','nemotron-3-ultra','nemotron-3-nano:30b'))
     GROUP BY m.id
     ORDER BY last_benchmark ASC, p.name, m.display_name`
  ).all<{ id: number; display_name: string; provider_model_id: string; provider: string; last_benchmark: string | null }>();

  // Prefetch cooldowns and RPM usage in parallel (reduces I/O) — tolerant to missing tables before migration
  const [providerCooldowns, modelCooldowns, rpmUsage] = await Promise.all([
    env.DB.prepare(`SELECT provider, cooldown_until FROM provider_cooldowns WHERE cooldown_until > ?`).bind(nowIso).all<{ provider: string; cooldown_until: string }>().catch(()=>({ results: [] } as any)),
    env.DB.prepare(`SELECT model_id FROM model_cooldowns WHERE cooldown_until > ?`).bind(nowIso).all<{ model_id: number }>().catch(()=>({ results: [] } as any)),
    env.DB.prepare(`SELECT provider, COUNT(*) as cnt FROM benchmark_runs WHERE started_at >= datetime('now','-60 seconds') GROUP BY provider`).bind().all<{ provider: string; cnt: number }>(),
  ] as const);
  const providerCooldownSet = new Set<string>((providerCooldowns.results ?? []).map((r: { provider: string })=>r.provider));
  const modelCooldownSet = new Set<number>((modelCooldowns.results ?? []).map((r: { model_id: number })=>r.model_id));
  const rpmMap = new Map<string, number>();
  for (const r of (rpmUsage.results ?? [] as Array<{ provider: string; cnt: number }>)) rpmMap.set((r as { provider: string }).provider, (r as { cnt: number }).cnt);

  // Group by provider after LRU sort, then filter cooldown/RPM
  const grouped = new Map<string, typeof active.results>();
  let skippedCooldown = 0;
  let skippedRPM = 0;
  // Track per-provider earliest last_benchmark for LRU ordering — first occurrence is earliest because active is sorted by last_benchmark ASC
  const providerEarliest = new Map<string, string | null>();
  for (const r of (active.results ?? []) as typeof active.results) {
    if (providerCooldownSet.has(r.provider)) { skippedCooldown++; continue; }
    if (modelCooldownSet.has(r.id)) { skippedCooldown++; continue; }
    const rpmLimit = rpmForProvider(r.provider, rpmConfig);
    const used = rpmMap.get(r.provider) ?? 0;
    if (used >= rpmLimit) { skippedRPM++; continue; }
    const arr = grouped.get(r.provider) ?? [];
    (arr as unknown[]).push(r);
    grouped.set(r.provider, arr as typeof active.results);
    if (!providerEarliest.has(r.provider)) providerEarliest.set(r.provider, r.last_benchmark);
  }
  // Sort providers by earliest last_benchmark (LRU) — never-hit (NULL) first, ensures tokenrouter with UNKNOWN gets hit next cycle instead of being starved alphabetically
  const providers = Array.from(grouped.keys()).sort((a,b)=>{
    const ea = providerEarliest.get(a);
    const eb = providerEarliest.get(b);
    if (ea === null && eb !== null) return -1;
    if (ea !== null && eb === null) return 1;
    if (ea === null && eb === null) return a.localeCompare(b);
    if (ea! < eb!) return -1;
    if (ea! > eb!) return 1;
    return a.localeCompare(b);
  });
  const jobs: BenchJob[] = [];
  const capMap = concurrency as unknown as Record<string, number>;
  const defaultCap = Math.max(2, Math.floor(concurrency.maxGlobal / 4));
  const getCap = (provider: string): number => {
    const base = (()=>{
      if (provider === "opencode_zen") return concurrency.maxOpencode;
      if (provider === "openrouter") return concurrency.maxOpenrouter;
      if (provider === "groq") return concurrency.maxGroq;
      if (provider === "cerebras") return concurrency.maxCerebras;
      if (provider === "gemini") return concurrency.maxGemini;
      if (provider === "nvidia") return concurrency.maxNvidia;
      if (provider === "sambanova") return concurrency.maxSambanova;
      if (provider === "mistral") return concurrency.maxMistral;
      if (provider === "agnes_ai") return concurrency.maxAgnesAi;
      if (provider === "aionlabs") return concurrency.maxAionlabs;
      if (provider === "kilocode") return concurrency.maxKilocode;
      if (provider === "glhf") return concurrency.maxGlhf;
      if (provider === "nscale") return concurrency.maxNscale;
      if (provider === "speka") return concurrency.maxSpeka;
      if (provider === "nexaapi") return concurrency.maxNexaapi;
      if (provider === "orcarouter") return concurrency.maxOrcarouter;
      if (provider === "ninerouter") return concurrency.maxNinerouter;
      if (provider === "tokenrouter") return concurrency.maxTokenrouter;
      if (provider === "ollama") return concurrency.maxOllama;
      const key = `max${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
      return capMap[key] ?? defaultCap;
    })();
    // RPM-aware cap: don't exceed remaining RPM budget this minute
    const rpmLimit = rpmForProvider(provider, rpmConfig);
    const used = rpmMap.get(provider) ?? 0;
    const rpmAvailable = Math.max(0, rpmLimit - used);
    return Math.min(base, rpmAvailable || base);
  };
  // Edge: if RPM available is 0, provider already skipped above, but double-check
  let global = 0;
  // Round-robin with smart rotation: since grouped lists are LRU sorted, picking idx 0 each time hits least-recently-benchmarked model
  let round = 0;
  const maxRounds = Math.max(...Array.from(grouped.values()).map((v) => (v as unknown[]).length), 0);
  const takenPerProvider = new Map<string, number>();
  const indexPerProvider = new Map<string, number>();
  for (round = 0; round < maxRounds; round++) {
    for (const prov of providers) {
      if (global >= concurrency.maxGlobal) break;
      // Re-check RPM before each pick (rpmAvailable may have decreased as we schedule)
      const rpmLimit = rpmForProvider(prov, rpmConfig);
      const used = (rpmMap.get(prov) ?? 0) + (takenPerProvider.get(prov) ?? 0);
      if (used >= rpmLimit) continue;
      const list = grouped.get(prov)! as unknown as Array<{ id: number; display_name: string; provider_model_id: string; provider: string }>;
      const idx = indexPerProvider.get(prov) ?? 0;
      if (idx >= list.length) continue;
      const cur = takenPerProvider.get(prov) ?? 0;
      if (cur >= getCap(prov)) continue;
      const row = list[idx]!;
      indexPerProvider.set(prov, idx + 1);
      jobs.push({
        model_id: row.id,
        provider: row.provider,
        provider_model_id: row.provider_model_id,
        benchmark_type: chosenType,
        display_name: row.display_name,
      });
      takenPerProvider.set(prov, cur + 1);
      global++;
    }
    if (global >= concurrency.maxGlobal) break;
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
  // --- Cooldown handling: distinguish model-specific vs provider-wide timeout ---
  try {
    const status = result.status;
    const http = (result as unknown as { http_status?: number | null }).http_status ?? result.http_status ?? null;
    const err = (result.error_type ?? "").toLowerCase();
    if (status === "SUCCESS") {
      // Success clears model cooldown (model recovered); provider cooldown persists until expiry or manual reset
      await clearModelCooldown(env.DB, job.model_id);
      // If provider had only this model's failures, we could clear provider cooldown on sustained success, but keep conservative
    } else if (status === "RATE_LIMITED" || http === 429 || err.includes("rate limit") || err.includes("too many requests")) {
      // Provider refusing — provider-wide cooldown (not just model)
      // Use Retry-After if available, else 60s + jitter via helper
      const retryMs = 60_000; // default 60s, could parse Retry-After from error_type if present
      await setProviderCooldown(env.DB, job.provider, retryMs, `RATE_LIMITED ${result.error_type ?? "429"}`);
      // Also brief model cooldown to avoid immediate retry of same model
      await setModelCooldown(env.DB, job.model_id, 30_000, `RATE_LIMITED`);
    } else if (status === "MODEL_UNAVAILABLE" || http === 404) {
      // Model-specific: model doesn't exist or not available — cooldown only this model (10m)
      await setModelCooldown(env.DB, job.model_id, 10 * 60 * 1000, `MODEL_UNAVAILABLE ${result.error_type ?? "404"}`);
    } else if (status === "TIMEOUT") {
      // Timeout is model-specific (model slow), not provider — short model cooldown (2m)
      await setModelCooldown(env.DB, job.model_id, 2 * 60 * 1000, `TIMEOUT`);
    } else if (err.includes("insufficient") || err.includes("quota") || err.includes("credit") || err.includes("balance") || err.includes("recharge")) {
      // Quota/balance errors are provider-wide (account level) — longer cooldown and proper display
      await setProviderCooldown(env.DB, job.provider, 15 * 60 * 1000, `QUOTA_EXCEEDED ${result.error_type ?? ""}`.slice(0,500));
      await setModelCooldown(env.DB, job.model_id, 5 * 60 * 1000, `QUOTA_EXCEEDED`);
    } else if (status === "PROVIDER_ERROR" && http != null && http >= 500) {
      if (err.includes("model") || err.includes("not found")) {
        await setModelCooldown(env.DB, job.model_id, 5 * 60 * 1000, `PROVIDER_ERROR model-specific 5xx`);
      } else {
        await setProviderCooldown(env.DB, job.provider, 30_000, `PROVIDER_ERROR 5xx`);
        await setModelCooldown(env.DB, job.model_id, 30_000, `PROVIDER_ERROR 5xx`);
      }
    } else if (status === "STREAM_ERROR" || status === "PROVIDER_ERROR") {
      await setModelCooldown(env.DB, job.model_id, 3 * 60 * 1000, `${status} ${result.error_type ?? ""}`);
    }
  } catch (e) { console.warn("cooldown handling", e); }
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
