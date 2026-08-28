/** Pure benchmark-job selection — LRU rotation, RPM budgeting, cooldown filtering,
 *  round-robin per-provider caps. Extracted from scheduleBenchmarks so the scheduler
 *  brain is unit-testable without D1 or Queues.
 *
 *  Input contract: models MUST be pre-sorted by last_benchmark ASC (NULLs first) —
 *  that ordering is what makes "pick index 0 first" hit least-recently-benchmarked models.
 */

export interface SelectableModel {
  id: number;
  display_name: string;
  provider_model_id: string;
  provider: string;
  last_benchmark: string | null;
}

export interface QueueJob {
  model_id: number;
  provider: string;
  provider_model_id: string;
  benchmark_type: string;
  display_name: string;
}

export interface SelectionConfig {
  maxGlobal: number;
  /** Per-provider concurrency cap (already RPM-clamped if desired). */
  capFor(provider: string): number;
  /** Per-provider requests-per-minute budget. */
  rpmLimitFor(provider: string): number;
  providerCooldowns: ReadonlySet<string>;
  modelCooldowns: ReadonlySet<number>;
  /** Provider → benchmark runs started in the current RPM window. */
  rpmUsage: ReadonlyMap<string, number>;
  benchmarkType: string;
}

export interface SelectionResult {
  jobs: QueueJob[];
  skippedCooldown: number;
  skippedRPM: number;
}

export function selectJobs(models: SelectableModel[], cfg: SelectionConfig): SelectionResult {
  const grouped = new Map<string, SelectableModel[]>();
  let skippedCooldown = 0;
  let skippedRPM = 0;

  for (const r of models) {
    if (cfg.providerCooldowns.has(r.provider)) {
      skippedCooldown++;
      continue;
    }
    if (cfg.modelCooldowns.has(r.id)) {
      skippedCooldown++;
      continue;
    }
    const used = cfg.rpmUsage.get(r.provider) ?? 0;
    if (used >= cfg.rpmLimitFor(r.provider)) {
      skippedRPM++;
      continue;
    }
    const arr = grouped.get(r.provider);
    if (arr) arr.push(r);
    else grouped.set(r.provider, [r]);
  }

  // Per-provider LRU: ensure each provider's list is sorted by last_benchmark ASC
  // (nulls first = never-benchmarked). Input is globally sorted, but per-provider sort
  // guarantees round-robin rotation hits the oldest models of EACH provider first,
  // even if global order interleaves differently. This is what makes
  // "first 3 models at tick 1, next 3 at tick 2 per provider" deterministic.
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      if (a.last_benchmark === null && b.last_benchmark !== null) return -1;
      if (a.last_benchmark !== null && b.last_benchmark === null) return 1;
      if (a.last_benchmark === null && b.last_benchmark === null) return a.display_name.localeCompare(b.display_name);
      const aTime = a.last_benchmark as string;
      const bTime = b.last_benchmark as string;
      if (aTime < bTime) return -1;
      if (aTime > bTime) return 1;
      return a.display_name.localeCompare(b.display_name);
    });
  }

  // LRU across providers: order by each provider's earliest last_benchmark.
  // After per-provider sort above, list[0] is the provider's oldest model.
  // NULLs first — never-benchmarked providers must not be starved alphabetically.
  const providerEarliest = new Map<string, string | null>();
  for (const [prov, list] of grouped) {
    providerEarliest.set(prov, list[0]?.last_benchmark ?? null);
  }
  const providers = Array.from(grouped.keys()).sort((a, b) => {
    const ea = providerEarliest.get(a) ?? null;
    const eb = providerEarliest.get(b) ?? null;
    if (ea === null && eb !== null) return -1;
    if (ea !== null && eb === null) return 1;
    if (ea === null && eb === null) return a.localeCompare(b);
    const eaStr = ea as string;
    const ebStr = eb as string;
    if (eaStr < ebStr) return -1;
    if (eaStr > ebStr) return 1;
    return a.localeCompare(b);
  });

  // Per-provider caps are the primary throttle (RPM + capFor). The global cap
  // is intentionally treated as an ENVELOPE: we pick up to capFor per provider
  // across all active providers each tick, then trim only if we exceed maxGlobal.
  // With maxGlobal raised to sum-of-caps (~40), this guarantees every provider
  // gets sampled every */5 window while respecting its own RPM/cooldown.
  // When maxGlobal is small (tests), we preserve fair round-robin starvation
  // by capping the envelope with the same round-robin loop.
  const effectiveGlobal = cfg.maxGlobal;
  const jobs: QueueJob[] = [];
  let global = 0;
  const maxRounds = Math.max(...Array.from(grouped.values()).map((v) => v.length), 0);
  const takenPerProvider = new Map<string, number>();
  const indexPerProvider = new Map<string, number>();

  for (let round = 0; round < maxRounds; round++) {
    for (const prov of providers) {
      if (global >= effectiveGlobal) break;
      // Re-check RPM before each pick — budget shrinks as we schedule this tick.
      const used = (cfg.rpmUsage.get(prov) ?? 0) + (takenPerProvider.get(prov) ?? 0);
      if (used >= cfg.rpmLimitFor(prov)) continue;
      const list = grouped.get(prov)!;
      const idx = indexPerProvider.get(prov) ?? 0;
      if (idx >= list.length) continue;
      const cur = takenPerProvider.get(prov) ?? 0;
      if (cur >= cfg.capFor(prov)) continue;
      const row = list[idx]!;
      indexPerProvider.set(prov, idx + 1);
      jobs.push({
        model_id: row.id,
        provider: row.provider,
        provider_model_id: row.provider_model_id,
        benchmark_type: cfg.benchmarkType,
        display_name: row.display_name,
      });
      takenPerProvider.set(prov, cur + 1);
      global++;
    }
    if (global >= effectiveGlobal) break;
  }

  return { jobs, skippedCooldown, skippedRPM };
}
