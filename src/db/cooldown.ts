/** Cooldown helpers — per-model vs per-provider timeout, RPM-aware */

export async function isProviderCooling(db: D1Database, provider: string): Promise<{ cooling: boolean; until?: string; reason?: string; remainingMs?: number }> {
  try {
    const row = await db.prepare(`SELECT cooldown_until, reason FROM provider_cooldowns WHERE provider=?`).bind(provider).first<{ cooldown_until: string; reason: string | null }>();
    if (!row) return { cooling: false };
    const untilMs = new Date(row.cooldown_until).getTime();
    const now = Date.now();
    if (untilMs <= now) {
      await db.prepare(`DELETE FROM provider_cooldowns WHERE provider=?`).bind(provider).run().catch(()=>{});
      return { cooling: false };
    }
    return { cooling: true, until: row.cooldown_until, reason: row.reason ?? undefined, remainingMs: untilMs - now };
  } catch { return { cooling: false }; }
}

export async function isModelCooling(db: D1Database, modelId: number): Promise<{ cooling: boolean; until?: string; reason?: string; remainingMs?: number }> {
  try {
    const row = await db.prepare(`SELECT cooldown_until, reason FROM model_cooldowns WHERE model_id=?`).bind(modelId).first<{ cooldown_until: string; reason: string | null }>();
    if (!row) return { cooling: false };
    const untilMs = new Date(row.cooldown_until).getTime();
    const now = Date.now();
    if (untilMs <= now) {
      await db.prepare(`DELETE FROM model_cooldowns WHERE model_id=?`).bind(modelId).run().catch(()=>{});
      return { cooling: false };
    }
    return { cooling: true, until: row.cooldown_until, reason: row.reason ?? undefined, remainingMs: untilMs - now };
  } catch { return { cooling: false }; }
}

export async function setProviderCooldown(db: D1Database, provider: string, durationMs: number, reason: string): Promise<void> {
  try {
    const until = new Date(Date.now() + durationMs).toISOString();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO provider_cooldowns (provider, cooldown_until, reason, updated_at) VALUES (?,?,?,?) ON CONFLICT(provider) DO UPDATE SET cooldown_until=excluded.cooldown_until, reason=excluded.reason, updated_at=excluded.updated_at`
    ).bind(provider, until, reason.slice(0, 500), now).run();
  } catch (e) { console.warn("setProviderCooldown", e); }
}

export async function setModelCooldown(db: D1Database, modelId: number, durationMs: number, reason: string): Promise<void> {
  try {
    const until = new Date(Date.now() + durationMs).toISOString();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO model_cooldowns (model_id, cooldown_until, reason, updated_at) VALUES (?,?,?,?) ON CONFLICT(model_id) DO UPDATE SET cooldown_until=excluded.cooldown_until, reason=excluded.reason, updated_at=excluded.updated_at`
    ).bind(modelId, until, reason.slice(0, 500), now).run();
  } catch (e) { console.warn("setModelCooldown", e); }
}

export async function clearProviderCooldown(db: D1Database, provider: string): Promise<void> {
  try { await db.prepare(`DELETE FROM provider_cooldowns WHERE provider=?`).bind(provider).run(); } catch {}
}

export async function clearModelCooldown(db: D1Database, modelId: number): Promise<void> {
  try { await db.prepare(`DELETE FROM model_cooldowns WHERE model_id=?`).bind(modelId).run(); } catch {}
}

export async function clearAllCooldownsForProvider(db: D1Database, provider: string): Promise<number> {
  try {
    const prov = await db.prepare(`DELETE FROM provider_cooldowns WHERE provider=?`).bind(provider).run();
    const models = await db.prepare(`SELECT id FROM models WHERE provider_id=(SELECT id FROM providers WHERE name=?)`).bind(provider).all<{ id: number }>();
    const ids = (models.results ?? []).map(r=>r.id);
    if (ids.length) {
      const ph = ids.map(()=>'?').join(',');
      await db.prepare(`DELETE FROM model_cooldowns WHERE model_id IN (${ph})`).bind(...ids).run().catch(()=>{});
    }
    return prov.meta.changes ?? 0;
  } catch { return 0; }
}

export async function getActiveCooldowns(db: D1Database): Promise<{ providers: Array<{ provider: string; cooldown_until: string; reason: string | null }>, models: Array<{ model_id: number; provider: string; provider_model_id: string; cooldown_until: string; reason: string | null }> }> {
  try {
    const now = new Date().toISOString();
    const provRows = await db.prepare(`SELECT provider, cooldown_until, reason FROM provider_cooldowns WHERE cooldown_until > ? ORDER BY cooldown_until ASC`).bind(now).all<{ provider: string; cooldown_until: string; reason: string | null }>();
    const modelRows = await db.prepare(
      `SELECT mc.model_id, mc.cooldown_until, mc.reason, p.name as provider, m.provider_model_id FROM model_cooldowns mc JOIN models m ON m.id=mc.model_id JOIN providers p ON p.id=m.provider_id WHERE mc.cooldown_until > ? ORDER BY mc.cooldown_until ASC`
    ).bind(now).all<{ model_id: number; provider: string; provider_model_id: string; cooldown_until: string; reason: string | null }>();
    return { providers: provRows.results ?? [], models: modelRows.results ?? [] };
  } catch {
    return { providers: [], models: [] };
  }
}

export async function getProviderRPMUsage(db: D1Database, windowMs = 60000): Promise<Map<string, number>> {
  try {
    const since = new Date(Date.now() - windowMs).toISOString();
    const rows = await db.prepare(`SELECT provider, COUNT(*) as cnt FROM benchmark_runs WHERE started_at >= ? GROUP BY provider`).bind(since).all<{ provider: string; cnt: number }>();
    const m = new Map<string, number>();
    for (const r of (rows.results ?? [])) m.set(r.provider, r.cnt);
    return m;
  } catch { return new Map(); }
}
