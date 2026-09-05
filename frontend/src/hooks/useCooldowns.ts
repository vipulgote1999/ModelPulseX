import { useEffect, useState, useCallback } from "react";

export interface CooldownsResp {
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
  now: string;
  meta: { providerCooldowns: number; modelCooldowns: number };
}

// Shared across all hook instances: CooldownPanel polls every 10s and the
// Leaderboard every 12s for the same endpoint. Module-level dedup collapses
// that into ~1 request per window per visitor; hidden tabs skip entirely.
const SHARE_MS = 10000;
let shared: {
  at: number;
  data: CooldownsResp | null;
  inflight: Promise<CooldownsResp | null> | null;
} = { at: 0, data: null, inflight: null };

async function fetchShared(): Promise<CooldownsResp | null> {
  const now = Date.now();
  if (shared.data && now - shared.at < SHARE_MS) return shared.data;
  if (shared.inflight) return shared.inflight;
  const p = (async (): Promise<CooldownsResp | null> => {
    try {
      const r = await fetch("/api/cooldowns");
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as CooldownsResp;
      shared = { at: Date.now(), data: j, inflight: null };
      return j;
    } catch {
      shared = { ...shared, inflight: null };
      return shared.data;
    }
  })();
  shared = { ...shared, inflight: p };
  return p;
}

export function useCooldowns(pollMs = 15000) {
  const [data, setData] = useState<CooldownsResp | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchNow = useCallback(async (force = false) => {
    // Background tabs don't need fresh cooldowns — skip, keep last data.
    if (!force && typeof document !== "undefined" && document.hidden) return;
    if (force) shared = { at: 0, data: shared.data, inflight: null };
    try {
      const j = await fetchShared();
      if (j) setData(j);
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

  return { data, loading, refresh: () => fetchNow(true) };
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
