import type { Env } from "../types";

/** ISO cutoff for time-window SQL — SQLite datetime('now',…) emits space-separated
 *  timestamps that string-compare BELOW ISO-'T' columns, silently widening every window
 *  to "since UTC midnight". Always compute cutoffs in JS and bind them instead. */
export const isoHoursAgo = (h: number): string =>
  new Date(Date.now() - h * 3600_000).toISOString();

export function isAdmin(
  c: { req: { header(n: string): string | undefined } },
  env: Env,
): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  const auth = c.req.header("authorization") ?? "";
  const x = c.req.header("x-admin-token") ?? "";
  return auth === `Bearer ${token}` || auth === token || x === token;
}
