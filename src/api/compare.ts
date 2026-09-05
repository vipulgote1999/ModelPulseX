import { Hono } from "hono";
import type { Env } from "../types";
import { isoHoursAgo } from "./shared";
import { escapeLikePattern, sanitizeSearchQuery } from "../utils/security";

export function compareRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/compare", async (c) => {
    const model = c.req.query("model");
    const modelsParam = c.req.query("models");
    let ids: number[] = [];
    if (modelsParam) ids = modelsParam.split(",").map(Number).filter(Boolean);
    else if (model) {
      const safe = sanitizeSearchQuery(model, 80);
      if (!safe) return c.json({ error: "no models matched" }, 404);
      const escaped = escapeLikePattern(safe);
      const pattern = `%${escaped}%`;
      const rows = await env.DB.prepare(
        "SELECT id FROM models WHERE provider_model_id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'",
      )
        .bind(pattern, pattern)
        .all<{ id: number }>();
      ids = (rows.results ?? []).map((r) => r.id);
    }
    if (ids.length === 0) return c.json({ error: "no models matched" }, 404);
    ids = ids.slice(0, 8);
    const placeholders = ids.map(() => "?").join(",");
    const [metas, stats7, raw24, raw7] = await Promise.all([
      env.DB.prepare(
        `SELECT m.id, m.provider_model_id, m.display_name, p.name as provider FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<{
          id: number;
          provider_model_id: string;
          display_name: string;
          provider: string;
        }>(),
      env.DB.prepare(
        `SELECT model_id, avg(median_tps) as tps_7d FROM hourly_model_stats WHERE model_id IN (${placeholders}) AND hour_start >= ? GROUP BY model_id`,
      )
        .bind(...ids, isoHoursAgo(168))
        .all<{ model_id: number; tps_7d: number | null }>(),
      env.DB.prepare(
        `SELECT model_id, avg(tps) as tps_24h, avg(ttft_ms) as ttft_24h FROM benchmark_runs WHERE model_id IN (${placeholders}) AND started_at >= ? AND status='SUCCESS' GROUP BY model_id`,
      )
        .bind(...ids, isoHoursAgo(24))
        .all<{
          model_id: number;
          tps_24h: number | null;
          ttft_24h: number | null;
        }>(),
      env.DB.prepare(
        `SELECT model_id, avg(tps) as tps_7d_raw, avg(ttft_ms) as ttft_7d, avg(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as up7, avg(CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END) as er FROM benchmark_runs WHERE model_id IN (${placeholders}) AND started_at >= ? GROUP BY model_id`,
      )
        .bind(...ids, isoHoursAgo(168))
        .all<{
          model_id: number;
          tps_7d_raw: number | null;
          ttft_7d: number | null;
          up7: number | null;
          er: number | null;
        }>(),
    ]);

    const metaMap = new Map<
      number,
      { provider_model_id: string; display_name: string; provider: string }
    >();
    for (const r of metas.results ?? []) metaMap.set(r.id, r);
    const s7Map = new Map<number, number | null>();
    for (const r of stats7.results ?? []) s7Map.set(r.model_id, r.tps_7d);
    const r24Map = new Map<
      number,
      { tps_24h: number | null; ttft_24h: number | null }
    >();
    for (const r of raw24.results ?? [])
      r24Map.set(r.model_id, { tps_24h: r.tps_24h, ttft_24h: r.ttft_24h });
    const r7Map = new Map<
      number,
      {
        tps_7d_raw: number | null;
        ttft_7d: number | null;
        up7: number | null;
        er: number | null;
      }
    >();
    for (const r of (raw7.results ?? []) as typeof raw7.results)
      r7Map.set(r.model_id, {
        tps_7d_raw: r.tps_7d_raw,
        ttft_7d: r.ttft_7d,
        up7: r.up7,
        er: r.er,
      });

    const out: unknown[] = [];
    for (const id of ids) {
      const mm = metaMap.get(id);
      if (!mm) continue;
      const r24 = r24Map.get(id);
      const r7 = r7Map.get(id);
      out.push({
        model_id: id,
        provider: mm.provider,
        model: mm.provider_model_id,
        display_name: mm.display_name,
        tps_24h: r24?.tps_24h ?? null,
        tps_7d: s7Map.get(id) ?? r7?.tps_7d_raw ?? null,
        ttft_24h: r24?.ttft_24h ?? null,
        ttft_7d: r7?.ttft_7d ?? null,
        uptime_7d: r7?.up7 ?? null,
        error_rate: r7?.er ?? null,
      });
    }
    let recommended: unknown = null;
    if (out.length >= 2) {
      const sorted = [
        ...(out as Array<{ tps_7d: number | null; provider: string }>),
      ].sort((a, b) => (b.tps_7d ?? -1) - (a.tps_7d ?? -1));
      recommended = sorted[0]?.provider ?? null;
    }
    return c.json({ compare: out, recommended_provider: recommended });
  });
  return r;
}
