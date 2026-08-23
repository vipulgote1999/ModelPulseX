import { useEffect, useState, useCallback } from "react";

export interface CooldownsResp {
  providers: Array<{ provider: string; cooldown_until: string; reason: string | null }>;
  models: Array<{ model_id: number; provider: string; provider_model_id: string; cooldown_until: string; reason: string | null }>;
  now: string;
  meta: { providerCooldowns: number; modelCooldowns: number };
}

export function useCooldowns(pollMs = 15000) {
  const [data, setData] = useState<CooldownsResp | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchNow = useCallback(async () => {
    try {
      const r = await fetch("/api/cooldowns");
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as CooldownsResp;
      setData(j);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNow();
    const id = setInterval(fetchNow, pollMs);
    return () => clearInterval(id);
  }, [fetchNow, pollMs]);

  return { data, loading, refresh: fetchNow };
}

export function remainingStr(until: string): string {
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
