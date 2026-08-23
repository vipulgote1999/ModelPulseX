import { useEffect, useState } from "react";

export function useHistory(modelIds: number[], range: string, benchmark: string) {
  const [data, setData] = useState<Record<number, Array<{ hour_start: string; median_tps: number | null; median_ttft: number | null; success_rate: number | null; uptime: number | null }>>>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (modelIds.length === 0) { setData({}); return; }
    setLoading(true);
    Promise.all(
      modelIds.map(async (id) => {
        const qs = new URLSearchParams({ range, benchmark });
        const res = await fetch(`/api/models/${id}/history?${qs}`);
        const j = (await res.json()) as { history?: Array<{ hour_start: string; median_tps: number | null; median_ttft: number | null }> };
        return [id, (j.history ?? []) as Array<{ hour_start: string; median_tps: number | null; median_ttft: number | null }>] as const;
      }),
    )
      .then((entries) => {
        const m: Record<number, typeof data[number]> = {};
        for (const [id, hist] of entries) m[id] = hist as unknown as typeof data[number];
        setData(m);
      })
      .finally(() => setLoading(false));
  }, [modelIds.join(","), range, benchmark]);
  return { data, loading };
}
