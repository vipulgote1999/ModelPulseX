/** Scheduler heartbeat + staleness watchdog — makes cron/enqueue health observable and alertable.
 *  All writers tolerate a missing table (pre-migration) so scheduling never breaks on schema lag. */
import type { SchedulerHealth } from "../types";
import { assertSafeApiUrl, BlockedApiUrlError } from "../benchmark/engine";

const EMPTY: SchedulerHealth = {
  last_schedule_at: null,
  last_enqueue_count: 0,
  last_inline_count: 0,
  last_skipped_cooldown: 0,
  last_skipped_rpm: 0,
  last_discovery_at: null,
  last_aggregate_at: null,
  last_stale_alert_at: null,
};

export async function getSchedulerHealth(db: D1Database): Promise<SchedulerHealth> {
  try {
    const row = await db
      .prepare(`SELECT * FROM scheduler_health WHERE id=1`)
      .first<SchedulerHealth>();
    return row ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

export interface ScheduleTick {
  enqueueCount: number;
  inlineCount: number;
  skippedCooldown: number;
  skippedRpm: number;
}

/** Persist the result of one 5-minute benchmark-scheduler tick (upsert singleton). */
export async function recordScheduleTick(db: D1Database, t: ScheduleTick): Promise<void> {
  try {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO scheduler_health (id, last_schedule_at, last_enqueue_count, last_inline_count, last_skipped_cooldown, last_skipped_rpm, updated_at)
         VALUES (1,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           last_schedule_at=excluded.last_schedule_at,
           last_enqueue_count=excluded.last_enqueue_count,
           last_inline_count=excluded.last_inline_count,
           last_skipped_cooldown=excluded.last_skipped_cooldown,
           last_skipped_rpm=excluded.last_skipped_rpm,
           updated_at=excluded.updated_at`,
      )
      .bind(now, t.enqueueCount, t.inlineCount, t.skippedCooldown, t.skippedRpm, now)
      .run();
  } catch (e) {
    console.warn("recordScheduleTick", e);
  }
}

/** Record that discovery / aggregation ran on the hourly tick. */
export async function recordHourlyJob(
  db: D1Database,
  job: "discovery" | "aggregate",
): Promise<void> {
  const col = job === "discovery" ? "last_discovery_at" : "last_aggregate_at";
  try {
    const now = new Date().toISOString();
    // Upsert, not UPDATE-only: a missing singleton row (deleted/pre-migration)
    // would otherwise swallow every timestamp silently. Column is a trusted
    // internal constant, never user input — safe to interpolate.
    await db
      .prepare(
        `INSERT INTO scheduler_health (id, ${col}, updated_at) VALUES (1,?,?)
         ON CONFLICT(id) DO UPDATE SET ${col}=excluded.${col}, updated_at=excluded.updated_at`,
      )
      .bind(now, now)
      .run();
  } catch (e) {
    console.warn("recordHourlyJob", e);
  }
}

export async function getLastBenchmarkAt(db: D1Database): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT MAX(started_at) as m FROM benchmark_runs`)
      .first<{ m: string | null }>();
    return row?.m ?? null;
  } catch {
    return null;
  }
}

function staleMinutes(env: { STALE_ALERT_MINUTES?: string }): number {
  const n = Number(env.STALE_ALERT_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Pure staleness/alert decision — unit-testable core of the watchdog.
 *  alertDue is true only when stale AND not alerted within the last hour. */
export function shouldAlertStale(
  lastBenchmarkAt: string | null,
  lastAlertAtMs: number,
  thresholdMinutes: number,
  nowMs: number,
): { stale: boolean; ageMinutes: number | null; alertDue: boolean } {
  if (!lastBenchmarkAt) return { stale: true, ageMinutes: null, alertDue: false };
  const ageMinutes = Math.round((nowMs - new Date(lastBenchmarkAt).getTime()) / 60000);
  const stale = ageMinutes > thresholdMinutes;
  const alertDue = stale && nowMs - lastAlertAtMs >= 60 * 60 * 1000;
  return { stale, ageMinutes, alertDue };
}

/** Fire ALERT_WEBHOOK_URL when data is stale. Rate-limits itself to one alert/hour
 *  via last_stale_alert_at. Returns what happened (for logging/tests). */
export async function watchdogCheck(
  db: D1Database,
  env: { ALERT_WEBHOOK_URL?: string; STALE_ALERT_MINUTES?: string },
  nowMs: number = Date.now(),
): Promise<{ stale: boolean; ageMinutes: number | null; alerted: boolean }> {
  const last = await getLastBenchmarkAt(db);
  const health = await getSchedulerHealth(db);
  const lastAlertAtMs = health.last_stale_alert_at ? new Date(health.last_stale_alert_at).getTime() : 0;
  const decision = shouldAlertStale(last, lastAlertAtMs, staleMinutes(env), nowMs);
  if (!decision.alertDue) return { stale: decision.stale, ageMinutes: decision.ageMinutes, alerted: false };

  if (env.ALERT_WEBHOOK_URL) {
    try {
      // SSRF guard: webhook target must be a clean https URL (same policy as provider calls).
      assertSafeApiUrl(env.ALERT_WEBHOOK_URL);
      const content =
        `🔴 ModelPulseX pipeline STALE — no benchmarks for ${decision.ageMinutes}m ` +
        `(threshold ${staleMinutes(env)}m). Last: ${last}. Check scheduler_health meta + queue DLQ.`;
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, text: content, message: content }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (e instanceof BlockedApiUrlError) console.warn("watchdog webhook blocked:", e.message);
      else console.warn("watchdog webhook", e);
    }
  }
  try {
    const now = new Date(nowMs).toISOString();
    await db
      .prepare(`UPDATE scheduler_health SET last_stale_alert_at=?, updated_at=? WHERE id=1`)
      .bind(now, now)
      .run();
  } catch (e) {
    console.warn("watchdog persist", e);
  }
  return { stale: true, ageMinutes: decision.ageMinutes, alerted: true };
}
