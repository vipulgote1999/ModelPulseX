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

  // LRU across providers: order by each provider's earliest last_benchmark (input is
  // pre-sorted ASC, so the first occurrence per provider is its earliest). NULLs first —
  // never-benchmarked providers must not be starved alphabetically.
  const providerEarliest = new Map<string, string | null>();
  for (const [prov, list] of grouped) {
    if (!providerEarliest.has(prov)) providerEarliest.set(prov, list[0]?.last_benchmark ?? null);
  }
  const providers = Array.from(grouped.keys()).sort((a, b) => {
    const ea = providerEarliest.get(a);
    const eb = providerEarliest.get(b);
    if (ea === null && eb !== null) return -1;
    if (ea !== null && eb === null) return 1;
    if (ea === null && eb === null) return a.localeCompare(b);
    if (ea! < eb!) return -1;
    if (ea! > eb!) return 1;
    return a.localeCompare(b);
  });

  const jobs: QueueJob[] = [];
  let global = 0;
  const maxRounds = Math.max(...Array.from(grouped.values()).map((v) => v.length), 0);
  const takenPerProvider = new Map<string, number>();
  const indexPerProvider = new Map<string, number>();

  for (let round = 0; round < maxRounds; round++) {
    for (const prov of providers) {
      if (global >= cfg.maxGlobal) break;
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
    if (global >= cfg.maxGlobal) break;
  }

  return { jobs, skippedCooldown, skippedRPM };
}
