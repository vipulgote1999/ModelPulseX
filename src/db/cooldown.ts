/** Cooldown helpers — per-model vs per-provider timeout, RPM-aware */

export async function isProviderCooling(
  db: D1Database,
  provider: string,
): Promise<{
  cooling: boolean;
  until?: string;
  reason?: string;
  remainingMs?: number;
}> {
  try {
    const row = await db
      .prepare(
        `SELECT cooldown_until, reason FROM provider_cooldowns WHERE provider=?`,
      )
      .bind(provider)
      .first<{ cooldown_until: string; reason: string | null }>();
    if (!row) return { cooling: false };
    const untilMs = new Date(row.cooldown_until).getTime();
    const now = Date.now();
    if (untilMs <= now) {
      await db
        .prepare(`DELETE FROM provider_cooldowns WHERE provider=?`)
        .bind(provider)
        .run()
        .catch(() => {});
      return { cooling: false };
    }
    return {
      cooling: true,
      until: row.cooldown_until,
      reason: row.reason ?? undefined,
      remainingMs: untilMs - now,
    };
  } catch {
    return { cooling: false };
  }
}

export async function isModelCooling(
  db: D1Database,
  modelId: number,
): Promise<{
  cooling: boolean;
  until?: string;
  reason?: string;
  remainingMs?: number;
}> {
  try {
    const row = await db
      .prepare(
        `SELECT cooldown_until, reason FROM model_cooldowns WHERE model_id=?`,
      )
      .bind(modelId)
      .first<{ cooldown_until: string; reason: string | null }>();
    if (!row) return { cooling: false };
    const untilMs = new Date(row.cooldown_until).getTime();
    const now = Date.now();
    if (untilMs <= now) {
      await db
        .prepare(`DELETE FROM model_cooldowns WHERE model_id=?`)
        .bind(modelId)
        .run()
        .catch(() => {});
      return { cooling: false };
    }
    return {
      cooling: true,
      until: row.cooldown_until,
      reason: row.reason ?? undefined,
      remainingMs: untilMs - now,
    };
  } catch {
    return { cooling: false };
  }
}

export async function setProviderCooldown(
  db: D1Database,
  provider: string,
  durationMs: number,
  reason: string,
): Promise<void> {
  try {
    const until = new Date(Date.now() + durationMs).toISOString();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO provider_cooldowns (provider, cooldown_until, reason, updated_at) VALUES (?,?,?,?) ON CONFLICT(provider) DO UPDATE SET cooldown_until=excluded.cooldown_until, reason=excluded.reason, updated_at=excluded.updated_at`,
      )
      .bind(provider, until, reason.slice(0, 500), now)
      .run();
  } catch (e) {
    console.warn("setProviderCooldown", e);
  }
}

/** Pure escalation math: doubling backoff while a cooldown is already active, capped.
 *  currentRemainingMs <= 0 or null means no active cooldown → plain base duration. */
export function escalatedDurationMs(
  currentRemainingMs: number | null,
  baseMs: number,
  maxMs: number,
): number {
  if (currentRemainingMs == null || currentRemainingMs <= 0) return baseMs;
  return Math.min(Math.max(currentRemainingMs * 2, baseMs), maxMs);
}

/** Cap for 429 backoff when the provider names no reset time. Per-minute limits
 *  (the common free-tier shape — live Zen FreeUsageLimitError 2026-09-09 carried
 *  no Retry-After and no rate headers) reset in seconds; blacking out for the
 *  2h default max turns one burst into hours of dead coverage. An explicit
 *  Retry-After is honored fully, even beyond the default max. */
export function rateLimitCapMs(
  retryAfterMs: number | null | undefined,
  defaultMaxMs: number,
): number {
  if (retryAfterMs != null && retryAfterMs > 0)
    return Math.max(defaultMaxMs, retryAfterMs);
  return Math.min(defaultMaxMs, 15 * 60 * 1000);
}

/** Provider-wide cooldown with exponential escalation for repeat offenders (quota exhaustion,
 *  sustained rate limiting). A provider that keeps failing backs off up to maxMs instead of
 *  re-burning benchmark capacity every few minutes. */
export async function escalateProviderCooldown(
  db: D1Database,
  provider: string,
  baseMs: number,
  reason: string,
  maxMs = 2 * 60 * 60 * 1000,
): Promise<void> {
  try {
    const row = await db
      .prepare(`SELECT cooldown_until FROM provider_cooldowns WHERE provider=?`)
      .bind(provider)
      .first<{ cooldown_until: string }>();
    const remaining = row
      ? new Date(row.cooldown_until).getTime() - Date.now()
      : null;
    await setProviderCooldown(
      db,
      provider,
      escalatedDurationMs(remaining, baseMs, maxMs),
      reason,
    );
  } catch {
    await setProviderCooldown(db, provider, baseMs, reason);
  }
}

export async function setModelCooldown(
  db: D1Database,
  modelId: number,
  durationMs: number,
  reason: string,
): Promise<void> {
  try {
    const until = new Date(Date.now() + durationMs).toISOString();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO model_cooldowns (model_id, cooldown_until, reason, updated_at) VALUES (?,?,?,?) ON CONFLICT(model_id) DO UPDATE SET cooldown_until=excluded.cooldown_until, reason=excluded.reason, updated_at=excluded.updated_at`,
      )
      .bind(modelId, until, reason.slice(0, 500), now)
      .run();
  } catch (e) {
    console.warn("setModelCooldown", e);
  }
}

export async function clearProviderCooldown(
  db: D1Database,
  provider: string,
): Promise<void> {
  try {
    await db
      .prepare(`DELETE FROM provider_cooldowns WHERE provider=?`)
      .bind(provider)
      .run();
  } catch (e) {
    console.warn("clearProviderCooldown", e);
  }
}

export async function clearModelCooldown(
  db: D1Database,
  modelId: number,
): Promise<void> {
  try {
    await db
      .prepare(`DELETE FROM model_cooldowns WHERE model_id=?`)
      .bind(modelId)
      .run();
  } catch (e) {
    console.warn("clearModelCooldown", e);
  }
}

export async function clearAllCooldownsForProvider(
  db: D1Database,
  provider: string,
): Promise<number> {
  try {
    const prov = await db
      .prepare(`DELETE FROM provider_cooldowns WHERE provider=?`)
      .bind(provider)
      .run();
    // Subquery delete: unbounded per-provider id lists (kilocode 800+) would
    // exceed D1's ~100 variable limit as an IN (...) bind list.
    await db
      .prepare(
        `DELETE FROM model_cooldowns WHERE model_id IN (SELECT id FROM models WHERE provider_id=(SELECT id FROM providers WHERE name=?))`,
      )
      .bind(provider)
      .run()
      .catch(() => {});
    return prov.meta.changes ?? 0;
  } catch {
    return 0;
  }
}

export async function getActiveCooldowns(db: D1Database): Promise<{
  providers: Array<{
    provider: string;
    cooldown_until: string;
    reason: string | null;
  }>;
  models: Array<{
    model_id: number;
    provider: string;
    provider_model_id: string;
    cooldown_until: string;
    reason: string | null;
  }>;
}> {
  try {
    const now = new Date().toISOString();
    const provRows = await db
      .prepare(
        `SELECT provider, cooldown_until, reason FROM provider_cooldowns WHERE cooldown_until > ? ORDER BY cooldown_until ASC`,
      )
      .bind(now)
      .all<{
        provider: string;
        cooldown_until: string;
        reason: string | null;
      }>();
    const modelRows = await db
      .prepare(
        `SELECT mc.model_id, mc.cooldown_until, mc.reason, p.name as provider, m.provider_model_id FROM model_cooldowns mc JOIN models m ON m.id=mc.model_id JOIN providers p ON p.id=m.provider_id WHERE mc.cooldown_until > ? ORDER BY mc.cooldown_until ASC`,
      )
      .bind(now)
      .all<{
        model_id: number;
        provider: string;
        provider_model_id: string;
        cooldown_until: string;
        reason: string | null;
      }>();
    return {
      providers: provRows.results ?? [],
      models: modelRows.results ?? [],
    };
  } catch {
    return { providers: [], models: [] };
  }
}

/** Per-provider request counts since an ISO cutoff.
 *
 *  Single home for the RPM/daily-budget query (scheduler tick + /api/providers).
 *
 *  `GROUP BY +provider` is load-bearing, not cosmetic. Without the unary `+`, SQLite
 *  satisfies GROUP BY from idx_benchmark_runs_provider_model's leading column and
 *  full-scans the entire 7-day run table (~10.6k rows read) on every call — it never
 *  uses `started_at >= ?` as an access path, and the filter is applied per row after
 *  the scan. That was 74% of the daily D1 rows-read budget (3.74M/day) and tripped the
 *  free-tier cap on 2026-09-10; see specs/bugs/BUG-2026-09-10-d1-row-read-cap.md.
 *
 *  `+` is a no-op in SQLite (`+'openrouter'` -> 'openrouter', `+NULL` -> NULL), so
 *  grouping and output are unchanged. It only blocks the index-order shortcut, forcing
 *  SEARCH ... (started_at>?) — ~1 row for the 60s RPM window, ~1.4k for 24h.
 *  Do not remove. */
export async function getProviderUsageSince(
  db: D1Database,
  sinceIso: string,
  /** Receives D1's `meta.rows_read` for this statement — the query that caused the
   *  2026-09 rows-read breach is measured at its single call site (issue #12). */
  onCost?: (rowsRead: number) => void,
): Promise<Map<string, number>> {
  try {
    const res = await db
      .prepare(
        `SELECT provider, COUNT(*) as cnt FROM benchmark_runs WHERE started_at >= ? GROUP BY +provider`,
      )
      .bind(sinceIso)
      .all<{ provider: string; cnt: number }>();
    onCost?.(res.meta?.rows_read ?? 0);
    const m = new Map<string, number>();
    for (const r of res.results ?? []) m.set(r.provider, r.cnt);
    return m;
  } catch {
    return new Map();
  }
}

export async function getProviderRPMUsage(
  db: D1Database,
  windowMs = 60000,
): Promise<Map<string, number>> {
  return getProviderUsageSince(
    db,
    new Date(Date.now() - windowMs).toISOString(),
  );
}

/** Requests per provider in the trailing 24h — lets the UI show consumption against a documented daily quota. */
export async function getProviderDailyUsage(
  db: D1Database,
  windowMs = 86_400_000,
): Promise<Map<string, number>> {
  return getProviderUsageSince(
    db,
    new Date(Date.now() - windowMs).toISOString(),
  );
}
