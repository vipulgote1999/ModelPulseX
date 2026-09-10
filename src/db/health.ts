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

export async function getSchedulerHealth(
  db: D1Database,
): Promise<SchedulerHealth> {
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
export async function recordScheduleTick(
  db: D1Database,
  t: ScheduleTick,
): Promise<void> {
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
      .bind(
        now,
        t.enqueueCount,
        t.inlineCount,
        t.skippedCooldown,
        t.skippedRpm,
        now,
      )
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

export async function getLastBenchmarkAt(
  db: D1Database,
): Promise<string | null> {
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

/** Where a stale-pipeline alert can actually go. `log-only` means no
 *  ALERT_WEBHOOK_URL secret is set, so "alerting" is a console line. */
export type AlertChannel = "configured" | "log-only";

export function alertChannelState(env: {
  ALERT_WEBHOOK_URL?: string;
}): AlertChannel {
  return env.ALERT_WEBHOOK_URL ? "configured" : "log-only";
}

/** Pure staleness/alert decision — unit-testable core of the watchdog.
 *  alertDue is true only when stale AND not alerted within the last hour. */
export function shouldAlertStale(
  lastBenchmarkAt: string | null,
  lastAlertAtMs: number,
  thresholdMinutes: number,
  nowMs: number,
): { stale: boolean; ageMinutes: number | null; alertDue: boolean } {
  if (!lastBenchmarkAt)
    return { stale: true, ageMinutes: null, alertDue: false };
  const ageMinutes = Math.round(
    (nowMs - new Date(lastBenchmarkAt).getTime()) / 60000,
  );
  const stale = ageMinutes > thresholdMinutes;
  const alertDue = stale && nowMs - lastAlertAtMs >= 60 * 60 * 1000;
  return { stale, ageMinutes, alertDue };
}

/** POST an alert to the configured webhook — the single alert channel, shared by the
 *  staleness watchdog and the D1 rows-read budget check (issue #12). Returns whether the
 *  message was delivered; `false` covers "no webhook configured" and delivery failure, so
 *  callers must not stamp an alert as sent on a false result. Never throws. */
export async function postWebhook(
  env: { ALERT_WEBHOOK_URL?: string },
  content: string,
): Promise<boolean> {
  const webhookUrl = env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return false;
  try {
    // SSRF guard: webhook target must be a clean https URL (same policy as provider calls).
    assertSafeApiUrl(webhookUrl);
    // Explicit https-only check at the sink so static analysis sees the
    // validation adjacent to the fetch (defense in depth with the above).
    const target = new URL(webhookUrl);
    if (target.protocol !== "https:")
      throw new BlockedApiUrlError("webhook must be https");
    // Sink uses the parsed+validated URL object, never the raw secret string.
    // pi-lens-ignore: ts-ssrf — documented false positive: this rule's post_filter
    // flags ANY fetch() whose URL text contains "." or matches /webhook|target/.
    // Verified to fire identically on the pre-existing HEAD code. The URL is an
    // operator-set Worker secret (not user input) and is validated above by
    // assertSafeApiUrl() plus an explicit https-only protocol check.
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, text: content, message: content }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
    return true;
  } catch (e) {
    // Delivery failed — callers must not stamp, so the next evaluation retries
    // instead of silencing alerts for an hour over an undelivered send.
    if (e instanceof BlockedApiUrlError)
      console.warn("webhook blocked:", e.message);
    else console.warn("webhook post failed", e);
    return false;
  }
}

/** Fire ALERT_WEBHOOK_URL when data is stale. Rate-limits itself to one alert/hour
 *  via last_stale_alert_at. Returns what happened (for logging/tests).
 *  With no webhook configured the channel is `log-only` and the stale state is
 *  logged at error level on every evaluation — never silently swallowed. */
export async function watchdogCheck(
  db: D1Database,
  env: { ALERT_WEBHOOK_URL?: string; STALE_ALERT_MINUTES?: string },
  nowMs: number = Date.now(),
): Promise<{
  stale: boolean;
  ageMinutes: number | null;
  alerted: boolean;
  channel: AlertChannel;
}> {
  const webhookUrl = env.ALERT_WEBHOOK_URL;
  const channel = alertChannelState(env);
  const last = await getLastBenchmarkAt(db);
  const health = await getSchedulerHealth(db);
  const lastAlertAtMs = health.last_stale_alert_at
    ? new Date(health.last_stale_alert_at).getTime()
    : 0;
  const decision = shouldAlertStale(
    last,
    lastAlertAtMs,
    staleMinutes(env),
    nowMs,
  );
  if (!decision.alertDue)
    return {
      stale: decision.stale,
      ageMinutes: decision.ageMinutes,
      alerted: false,
      channel,
    };

  if (channel === "log-only" || !webhookUrl) {
    // No webhook configured: the alert cannot be delivered. Emit an error-level
    // line on every stale evaluation so a stall shows up in `wrangler tail` /
    // Workers Logs instead of vanishing. Deliberately does NOT stamp
    // last_stale_alert_at, so configuring the secret makes the next tick fire
    // immediately rather than waiting out the hourly rate limit.
    console.error(
      `watchdog: STALE (${decision.ageMinutes ?? "unknown"}m since last benchmark, ` +
        `threshold ${staleMinutes(env)}m) and the alert channel is NOT CONFIGURED. ` +
        `Set the ALERT_WEBHOOK_URL secret to receive real alerts. Last: ${last}`,
    );
    return {
      stale: true,
      ageMinutes: decision.ageMinutes,
      alerted: false,
      channel,
    };
  }
  const content =
    `🔴 ModelPulseX pipeline STALE — no benchmarks for ${decision.ageMinutes}m ` +
    `(threshold ${staleMinutes(env)}m). Last: ${last}. Check scheduler_health meta + queue DLQ.`;
  const delivered = await postWebhook(env, content);
  if (!delivered) {
    return {
      stale: true,
      ageMinutes: decision.ageMinutes,
      alerted: false,
      channel,
    };
  }
  try {
    const now = new Date(nowMs).toISOString();
    await db
      .prepare(
        `UPDATE scheduler_health SET last_stale_alert_at=?, updated_at=? WHERE id=1`,
      )
      .bind(now, now)
      .run();
  } catch (e) {
    console.warn("watchdog persist", e);
  }
  return {
    stale: true,
    ageMinutes: decision.ageMinutes,
    alerted: true,
    channel,
  };
}
