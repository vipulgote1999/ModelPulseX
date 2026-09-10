/** Rows-read observability (issue #12).
 *
 *  The 2026-09 quota breach was fixed per query and is now guarded by
 *  `scripts/check-query-plans.mjs`, but nothing measured consumption from inside the
 *  Worker — the only signal was the Cloudflare dashboard. D1 reports `meta.rows_read`
 *  per statement, so the 5-minute tick adds the cost of the quota-critical query to a
 *  per-UTC-day counter (migration `0014`).
 *
 *  **Honesty:** only MEASURED shapes are counted. This is a lower bound on true account
 *  consumption, which is why the exposed field is `rows_read_measured_today` and not
 *  `rows_read_today`.
 */
import type { Env } from "../types";
import { postWebhook } from "./health";

/** Cloudflare D1 free tier: 5M rows read per day. Overridable for other plans. */
export const D1_FREE_TIER_ROWS_PER_DAY = 5_000_000;

export interface RowCostEntry {
  /** Query shape name, e.g. `provider-count`. */
  shape: string;
  rowsRead: number;
}

export interface RowsReadDay {
  day: string;
  rows_read: number;
  top_shape: string | null;
  top_rows: number | null;
}

export function utcDay(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Pure alert decision: fires once per day when measured rows cross `fraction` of the cap. */
export function rowsReadAlertDue(
  rowsRead: number,
  fraction: number,
  cap: number = D1_FREE_TIER_ROWS_PER_DAY,
): boolean {
  if (!Number.isFinite(rowsRead) || rowsRead <= 0) return false;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const f = Number.isFinite(fraction) && fraction > 0 ? fraction : 0.8;
  return rowsRead >= cap * f;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function alertFraction(env: Pick<Env, "ROWS_READ_ALERT_FRACTION">): number {
  return positiveNumber(env.ROWS_READ_ALERT_FRACTION, 0.8);
}

export function rowsCap(env: Pick<Env, "D1_DAILY_ROWS_CAP">): number {
  return positiveNumber(env.D1_DAILY_ROWS_CAP, D1_FREE_TIER_ROWS_PER_DAY);
}

/** Add one tick's measured cost to today's row. Returns the new total, or null if the
 *  table is missing / the write failed (never throws — scheduling must not depend on it). */
export async function recordRowsRead(
  db: D1Database,
  entries: RowCostEntry[],
  nowMs: number = Date.now(),
): Promise<number | null> {
  const measured = entries.filter((e) => Number.isFinite(e.rowsRead) && e.rowsRead > 0);
  if (measured.length === 0) return null;
  const day = utcDay(nowMs);
  const total = measured.reduce((s, e) => s + e.rowsRead, 0);
  const top = measured.reduce((a, b) => (b.rowsRead > a.rowsRead ? b : a));
  const now = new Date(nowMs).toISOString();
  try {
    const row = await db
      .prepare(
        `INSERT INTO rows_read_daily (day, rows_read, top_shape, top_rows, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(day) DO UPDATE SET
           rows_read = rows_read_daily.rows_read + excluded.rows_read,
           top_shape = CASE
             WHEN excluded.top_rows > COALESCE(rows_read_daily.top_rows, 0) THEN excluded.top_shape
             ELSE rows_read_daily.top_shape END,
           top_rows = MAX(COALESCE(rows_read_daily.top_rows, 0), COALESCE(excluded.top_rows, 0)),
           updated_at = excluded.updated_at
         RETURNING rows_read`,
      )
      .bind(day, total, top.shape, top.rowsRead, now)
      .first<{ rows_read: number }>();
    return row?.rows_read ?? null;
  } catch (e) {
    console.warn("rows-read accounting failed", e);
    return null;
  }
}

/** Today's measured total (lower bound on real consumption). Null when unavailable. */
export async function getRowsReadToday(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<RowsReadDay | null> {
  try {
    return await db
      .prepare(
        `SELECT day, rows_read, top_shape, top_rows FROM rows_read_daily WHERE day = ?`,
      )
      .bind(utcDay(nowMs))
      .first<RowsReadDay>();
  } catch {
    return null;
  }
}

/** Stamp `alerted_at` once, so the threshold breach is reported one time per day. */
export async function markRowsReadAlerted(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE rows_read_daily SET alerted_at = ? WHERE day = ? AND alerted_at IS NULL`,
      )
      .bind(new Date(nowMs).toISOString(), utcDay(nowMs))
      .run();
  } catch (e) {
    console.warn("rows-read alert stamp failed", e);
  }
}

/** Claim the day's alert slot atomically (returns true only for the winner), then report
 *  the breach on the same channel as the staleness watchdog. Never throws. */
export async function checkRowsReadBudget(
  db: D1Database,
  env: Pick<Env, "ALERT_WEBHOOK_URL" | "ROWS_READ_ALERT_FRACTION" | "D1_DAILY_ROWS_CAP">,
  nowMs: number = Date.now(),
): Promise<{ measured: number; cap: number; alerted: boolean } | null> {
  const today = await getRowsReadToday(db, nowMs);
  if (!today) return null;
  const cap = rowsCap(env);
  if (!rowsReadAlertDue(today.rows_read, alertFraction(env), cap))
    return { measured: today.rows_read, cap, alerted: false };
  try {
    const claimed = await db
      .prepare(
        `UPDATE rows_read_daily SET alerted_at = ? WHERE day = ? AND alerted_at IS NULL`,
      )
      .bind(new Date(nowMs).toISOString(), utcDay(nowMs))
      .run();
    // Lost the race (another tick already reported today) — stay quiet.
    if ((claimed.meta?.changes ?? 0) === 0)
      return { measured: today.rows_read, cap, alerted: false };
  } catch (e) {
    console.warn("rows-read alert claim failed", e);
    return { measured: today.rows_read, cap, alerted: false };
  }
  const pct = Math.round((today.rows_read / cap) * 100);
  const content =
    `🟠 ModelPulseX D1 rows-read budget: measured ${today.rows_read} rows today ` +
    `(${pct}% of the ${cap} cap, lower bound — measured shapes only; top shape ` +
    `"${today.top_shape ?? "unknown"}"). Today: ${today.day}. ` +
    `Check new query shapes against scripts/check-query-plans.mjs.`;
  console.error("rows-read budget: " + content);
  const delivered = await postWebhook(env, content);
  return { measured: today.rows_read, cap, alerted: delivered };
}
