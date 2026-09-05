export function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
export function fmtTps(v: number | null): string {
  // Zero/negative TPS is never a real measurement (computeTPS returns null for
  // empty runs; pre-fix empty completions stored exact 0.0) — show a dash.
  if (v == null || !(v > 0)) return "—";
  return v.toFixed(1);
}
export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
