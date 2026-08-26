/** One-shot guarded data fixes — replaces hardcoded cleanups that previously ran on EVERY
 *  discovery cycle (tokenrouter paid-purge, ollama allowlist). Each fix applies exactly once,
 *  tracked in the data_fixes table (migration 0006). Tolerates missing table pre-migration.
 */
const FIXES: Array<{ id: string; description: string; run: (db: D1Database) => Promise<void> }> = [
  {
    id: "2026-08-23_tokenrouter_paid_purge",
    description: "delete tokenrouter models that never had the free suffix (were never free)",
    run: async (db) => {
      const sub = `SELECT id FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free'`;
      await db.prepare(`DELETE FROM benchmark_runs WHERE model_id IN (${sub})`).bind(await tokenRouterId(db)).run();
      await db.prepare(`DELETE FROM hourly_model_stats WHERE model_id IN (${sub})`).bind(await tokenRouterId(db)).run();
      await db.prepare(`DELETE FROM availability_incidents WHERE model_id IN (${sub})`).bind(await tokenRouterId(db)).run();
      await db.prepare(`DELETE FROM models WHERE provider_id=? AND lower(provider_model_id) NOT LIKE '%free'`).bind(await tokenRouterId(db)).run();
    },
  },
  {
    id: "2026-08-23_ollama_free_allowlist",
    description: "keep only verified 7 free ollama models (others require subscription)",
    run: async (db) => {
      const freeOllama = ["gemma4:31b", "minimax-m3", "gpt-oss:20b", "gpt-oss:120b", "nemotron-3-super", "nemotron-3-ultra", "nemotron-3-nano:30b"];
      const pid = await ollamaId(db);
      if (!pid) return;
      const placeholders = freeOllama.map(() => "?").join(",");
      const sub = `SELECT id FROM models WHERE provider_id=? AND provider_model_id NOT IN (${placeholders})`;
      await db.prepare(`DELETE FROM benchmark_runs WHERE model_id IN (${sub})`).bind(pid, ...freeOllama).run();
      await db.prepare(`DELETE FROM hourly_model_stats WHERE model_id IN (${sub})`).bind(pid, ...freeOllama).run();
      await db.prepare(`DELETE FROM availability_incidents WHERE model_id IN (${sub})`).bind(pid, ...freeOllama).run();
      await db.prepare(`DELETE FROM models WHERE provider_id=? AND provider_model_id NOT IN (${placeholders})`).bind(pid, ...freeOllama).run();
    },
  },
];

async function tokenRouterId(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT id FROM providers WHERE name='tokenrouter'`).first<{ id: number }>();
  return row?.id ?? -1;
}
async function ollamaId(db: D1Database): Promise<number | null> {
  const row = await db.prepare(`SELECT id FROM providers WHERE name='ollama'`).first<{ id: number }>();
  return row?.id ?? null;
}

/** Apply every not-yet-applied fix exactly once. Returns ids applied this call. */
export async function applyDataFixes(db: D1Database): Promise<string[]> {
  try {
    const res = await db.prepare(`SELECT fix_id FROM data_fixes`).all<{ fix_id: string }>();
    const done = new Set((res.results ?? []).map((r) => r.fix_id));
    const appliedNow: string[] = [];
    for (const fix of FIXES) {
      if (done.has(fix.id)) continue;
      try {
        await fix.run(db);
        await db
          .prepare(`INSERT OR IGNORE INTO data_fixes (fix_id, applied_at) VALUES (?,?)`)
          .bind(fix.id, new Date().toISOString())
          .run();
        appliedNow.push(fix.id);
        console.error("data_fix applied:", fix.id, "-", fix.description);
      } catch (e) {
        console.warn("data_fix failed:", fix.id, e);
      }
    }
    return appliedNow;
  } catch {
    // table missing (pre-migration) — skip fixes rather than break discovery
    return [];
  }
}
