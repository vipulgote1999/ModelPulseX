import { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

const COLORS = [
  "#8b5cf6",
  "#06b6d4",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#e879f9",
  "#64748b",
];

type Failure = { bucket: string; provider: string; status: string; n: number };
type Provider = {
  provider: string;
  ok: number;
  rate_limited: number;
  timeouts: number;
  other_errors: number;
  total: number;
};

function foldTail(
  totals: Array<{ provider: string; n: number }>,
  limit = 6,
): string[] {
  if (totals.length <= limit) return totals.map((t) => t.provider);
  return [...totals.slice(0, limit).map((t) => t.provider), "Other"];
}

function bucketLabel(bucket: string, hourly: boolean): string {
  const d = hourly
    ? new Date(bucket + ":00:00Z")
    : new Date(bucket + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return bucket;
  return hourly
    ? d.toLocaleString(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
      })
    : d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

export default function TimeoutChart({ range }: { range: string }) {
  const [data, setData] = useState<{
    failures: Failure[];
    providers: Provider[];
    topModels: Array<{ provider: string; model: string; n: number }>;
    granularity: string;
    meta: {
      total_runs: number;
      total_failures: number;
      retention_note: string;
    };
  } | null>(null);

  useEffect(() => {
    let dead = false;
    const ctl = new AbortController();
    fetch(`/api/timeouts?range=${encodeURIComponent(range)}`, {
      signal: ctl.signal,
    })
      .then((r) => r.json())
      .then((j: unknown) => {
        if (!dead) {
          // SAFETY: /api/timeouts shape is owned by src/api/timeouts.ts; narrow to displayed fields
          const v = j as {
            failures?: Failure[];
            providers?: Provider[];
            topModels?: Array<{ provider: string; model: string; n: number }>;
            granularity?: string;
            meta?: {
              total_runs: number;
              total_failures: number;
              retention_note: string;
            };
          };
          setData({
            failures: v.failures ?? [],
            providers: v.providers ?? [],
            topModels: v.topModels ?? [],
            granularity: v.granularity ?? "daily",
            meta: v.meta ?? {
              total_runs: 0,
              total_failures: 0,
              retention_note: "",
            },
          });
        }
      })
      .catch((e) => {
        // Abort on range switch is normal — anything else keeps last data.
        if ((e as Error)?.name === "AbortError") return;
      });
    return () => {
      dead = true;
      ctl.abort();
    };
  }, [range]);

  const hourly = data?.granularity === "hourly";
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of data?.failures ?? [])
      m.set(f.provider, (m.get(f.provider) ?? 0) + f.n);
    return [...m.entries()]
      .map(([provider, n]) => ({ provider, n }))
      .sort((a, b) => b.n - a.n);
  }, [data]);
  const keys = useMemo(() => foldTail(totals), [totals]);
  // Dominant refusal reason beyond rate-limit/timeout, per provider — unhides
  // the "other" bucket (e.g. nscale's 100% refusals are MODEL_UNAVAILABLE).
  const topOther = useMemo(() => {
    const per = new Map<string, Map<string, number>>();
    for (const f of data?.failures ?? []) {
      if (f.status === "RATE_LIMITED" || f.status === "TIMEOUT") continue;
      let m = per.get(f.provider);
      if (!m) {
        m = new Map();
        per.set(f.provider, m);
      }
      m.set(f.status, (m.get(f.status) ?? 0) + f.n);
    }
    const out = new Map<string, { status: string; n: number }>();
    for (const [p, m] of per) {
      let best = "";
      let bn = 0;
      for (const [s, n] of m)
        if (n > bn) {
          best = s;
          bn = n;
        }
      if (best) out.set(p, { status: best, n: bn });
    }
    return out;
  }, [data]);

  const rows = useMemo(() => {
    const byBucket = new Map<string, Record<string, number | string>>();
    for (const f of data?.failures ?? []) {
      const key = keys.includes(f.provider) ? f.provider : "Other";
      const row = byBucket.get(f.bucket) ?? {
        bucket: bucketLabel(f.bucket, hourly),
      };
      row[key] = ((row[key] as number | undefined) ?? 0) + f.n;
      byBucket.set(f.bucket, row);
    }
    return [...byBucket.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, row]) => {
        for (const k of keys) if (row[k] == null) row[k] = 0;
        return row;
      });
  }, [data, keys, hourly]);

  if (!data)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-500 animate-pulse">
        Loading timeouts…
      </div>
    );

  const limited = (data.providers ?? []).filter(
    (p) => p.rate_limited + p.timeouts + p.other_errors > 0,
  );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
      <div className="text-sm font-semibold flex items-center justify-between flex-wrap gap-2">
        <span>
          Timeouts &amp; limits — who says no, when, how often (
          {data.meta.total_failures} refusals / {data.meta.total_runs} runs)
        </span>
        <span className="text-[11px] text-zinc-500 font-normal">
          {hourly ? "hourly buckets" : "daily buckets"} ·{" "}
          {data.meta.retention_note}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="p-8 text-center text-zinc-500">
          No timeouts recorded in this range — providers are behaving.
        </div>
      ) : (
        <div className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows}>
              <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 11, fill: "#a1a1aa" }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#a1a1aa" }}
                label={{
                  value: "refusals",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#a1a1aa",
                }}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  background: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: 10,
                }}
                labelStyle={{ color: "#e4e4e7" }}
              />
              <Legend />
              {keys.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  stackId="a"
                  fill={COLORS[i % COLORS.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {limited.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {limited.map((p) => {
            const bad = p.rate_limited + p.timeouts + p.other_errors;
            const pct = p.total > 0 ? ((bad / p.total) * 100).toFixed(1) : "—";
            const dom = topOther.get(p.provider);
            const showDom =
              dom != null && p.other_errors > p.rate_limited + p.timeouts;
            return (
              <div
                key={p.provider}
                className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-2"
                title={
                  `${p.provider}: ${p.rate_limited} rate-limited, ${p.timeouts} timeouts, ${p.other_errors} other errors out of ${p.total} runs` +
                  (dom ? ` · dominant: ${dom.status} (${dom.n})` : "")
                }
              >
                <div className="text-xs font-mono font-medium text-amber-300 truncate">
                  {p.provider}
                </div>
                <div className="text-sm mt-0.5">
                  <b className="mono">{bad}</b>{" "}
                  <span className="text-zinc-400 text-xs">
                    refusals ({pct}% of its runs)
                  </span>
                </div>
                <div className="text-[11px] text-zinc-500">
                  {p.rate_limited} limited · {p.timeouts} timeouts ·{" "}
                  {p.other_errors} other
                </div>
                {showDom && dom && (
                  <div className="text-[11px] text-zinc-400">
                    mostly {dom.status} ({dom.n})
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data.topModels.length > 0 && (
        <div className="text-[11px] text-zinc-500">
          Most refused models:{" "}
          {data.topModels.slice(0, 5).map((m) => (
            <span
              key={`${m.provider}:${m.model}`}
              className="text-zinc-400 font-mono"
              title={`${m.provider} · ${m.n} refusals`}
            >
              {m.model.split("/").pop()} ({m.n}){"  "}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
