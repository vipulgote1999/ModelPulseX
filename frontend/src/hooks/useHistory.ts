import { useEffect, useState } from "react";

type Point = { hour_start: string; median_tps: number | null; median_ttft: number | null; success_rate: number | null; uptime: number | null };

export function useHistory(modelIds: number[], range: string, benchmark: string) {
  const [data, setData] = useState<Record<number, Point[]>>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (modelIds.length === 0) {
      setData({});
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    // 5–10m granularity: 1h range uses tenmin buckets (6 points per hour) so graphs show
    // live 10m lines. Longer ranges keep hourly to stay readable. Backend honors
    // granularity=10m (tenmin_model_stats) with hourly fallback if not yet migrated.
    const granularity = range === "1h" ? "10m" : "hourly";
    const qs = new URLSearchParams({ ids: modelIds.join(","), range, benchmark, granularity });
    fetch(`/api/history?${qs}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { history?: Record<string, Point[]> };
        // endpoint returns map {id: points}; keep shape
        const raw = (j.history ?? {}) as Record<string, Point[]>;
        const m: Record<number, Point[]> = {};
        for (const id of modelIds) {
          m[id] = (raw[String(id)] ?? raw[id] ?? []) as Point[];
        }
        if (!controller.signal.aborted) setData(m);
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        // fallback to legacy per-model fetch on batch miss (e.g., old deploy)
        Promise.all(
          modelIds.map(async (id) => {
            try {
              const gran2 = range === "1h" ? "10m" : "hourly";
              const qs2 = new URLSearchParams({ range, benchmark, granularity: gran2 });
              const r = await fetch(`/api/models/${id}/history?${qs2}`, { signal: controller.signal });
              const jj = (await r.json()) as { history?: Point[] };
              return [id, (jj.history ?? []) as Point[]] as const;
            } catch {
              return [id, [] as Point[]] as const;
            }
          }),
        ).then((entries) => {
          if (controller.signal.aborted) return;
          const m: Record<number, Point[]> = {};
          for (const [id, hist] of entries) m[id] = hist;
          setData(m);
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [modelIds.join(","), range, benchmark]);
  return { data, loading };
}
