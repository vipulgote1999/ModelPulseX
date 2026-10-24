import { Hono } from "hono";
import type { Env } from "../types";
import { isoHoursAgo } from "./shared";
import { MIN_SAMPLES, parseConcatNumbers, percentile } from "../utils/metrics";
import { escapeLikePattern, sanitizeSearchQuery } from "../utils/security";
import { publicModelVisibilityWhere } from "../providers/registry";

export function compareRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/compare", async (c) => {
    const url = new URL(c.req.url);
    const model = c.req.query("model");
    const modelsParam = c.req.query("models");
    // Batch-3: the old map(Number).filter(Boolean) let "1.5"→1, "-1"→-1 and
    // "1,1,2" through as duplicates — fractional/negative ids hit SQL that can
    // never match, and doubles emit doubled rows. Strict positive ints, deduped.
    let ids: number[] = [];
    if (modelsParam)
      ids = [...new Set(modelsParam.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
    else if (model) {
      const safe = sanitizeSearchQuery(model, 80);
      if (!safe) return c.json({ error: "no models matched" }, 404);
      const escaped = escapeLikePattern(safe);
      // Leading-wildcard LIKE cannot use an index, so this scanned all of
      // `models` on every unauthenticated request, with no LIMIT, and it ran
      // BEFORE the cache lookup below. Bound it three ways: the public
      // visibility gate shrinks the scanned set to rows the caller may see,
      // LIMIT 8 matches the cap applied to `ids` just below, and the result is
      // now derived after the cache miss rather than before the cache check.
      const pattern = `%${escaped}%`;
      const rows = await env.DB.prepare(
        `SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id
         WHERE (m.provider_model_id LIKE ? ESCAPE '\\' OR m.display_name LIKE ? ESCAPE '\\')
           AND ${publicModelVisibilityWhere("p", "m")}
         ORDER BY m.free_status ASC, m.last_seen DESC LIMIT 8`,
      )
        .bind(pattern, pattern)
        .all<{ id: number }>();
      ids = (rows.results ?? []).map((r) => r.id);
    }
    if (ids.length === 0) return c.json({ error: "no models matched" }, 404);
    ids = ids.slice(0, 8);
    const placeholders = ids.map(() => "?").join(",");
    // Edge-cache 60s shared across visitors: same-model comparison is recomputed
    // on every pin change otherwise (4 aggregations over raw + hourly).
    // SAFETY: Workers runtime exposes caches.default at runtime; DOM lib types omit it.
    const cache: Cache = (caches as unknown as { default: Cache }).default;
    // Key on origin + path + the RESOLVED id set only. The raw URL was the key
    // before (SEC-007), so any junk param — `?x=<random>` — minted a fresh
    // cache object AND forced a fresh origin D1 read for a byte-identical
    // response. Two callers comparing the same models still share an entry.
    const cacheKey = new Request(
      `${url.origin}${url.pathname}?ids=${ids.join(",")}&v=2`,
      { method: "GET" },
    );
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      // Cache API unavailable (local dev) — fall through to D1
    }
    // Single db.batch round-trip: metadata → snapshot medians → raw 24h → raw 7d.
    // Snapshot rows are pre-gated at write time; the raw lists are the fallback
    // for models measured before the snapshot caught up.
    const [metasRes, snapRes, raw24Res, raw7Res] = await env.DB.batch([
      env.DB.prepare(
        `SELECT m.id, m.provider_model_id, m.display_name, p.name as provider FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id IN (${placeholders})`,
      ).bind(...ids),
      env.DB.prepare(
        `SELECT model_id, tps_24h, tps_7d, e2e_tps_24h, e2e_tps_7d,
                ttft_24h, ttft_7d, uptime_7d, error_rate_7d, median_chunks_7d
         FROM leaderboard_snapshot WHERE benchmark='all' AND model_id IN (${placeholders})`,
      ).bind(...ids),
      env.DB.prepare(
        `SELECT model_id,
                GROUP_CONCAT(tps) as gc_tps,
                GROUP_CONCAT(e2e_tps) as gc_e2e,
                GROUP_CONCAT(ttft_ms) as gc_ttft,
                COUNT(*) as cnt
         FROM benchmark_runs
         WHERE model_id IN (${placeholders}) AND started_at >= ?
         GROUP BY model_id`,
      ).bind(...ids, isoHoursAgo(24)),
      env.DB.prepare(
        `SELECT model_id,
                GROUP_CONCAT(tps) as gc_tps,
                GROUP_CONCAT(e2e_tps) as gc_e2e,
                GROUP_CONCAT(ttft_ms) as gc_ttft,
                GROUP_CONCAT(CASE WHEN status='SUCCESS' THEN chunk_count END) as gc_chunks,
                SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as ok7,
                COUNT(*) as cnt
         FROM benchmark_runs
         WHERE model_id IN (${placeholders}) AND started_at >= ?
         GROUP BY model_id`,
      ).bind(...ids, isoHoursAgo(168)),
    ]);
    // SAFETY: D1 batch returns untyped rows; SELECT aliases match the shapes below.
    const metas = (metasRes?.results ?? []) as Array<{
      id: number;
      provider_model_id: string;
      display_name: string;
      provider: string;
    }>;
    const snaps = (snapRes?.results ?? []) as Array<{
      model_id: number;
      tps_24h: number | null;
      tps_7d: number | null;
      e2e_tps_24h: number | null;
      e2e_tps_7d: number | null;
      ttft_24h: number | null;
      ttft_7d: number | null;
      uptime_7d: number | null;
      error_rate_7d: number | null;
      median_chunks_7d: number | null;
    }>;
    const raw24 = (raw24Res?.results ?? []) as Array<{
      model_id: number;
      gc_tps: string | null;
      gc_e2e: string | null;
      gc_ttft: string | null;
      cnt: number | null;
    }>;
    const raw7 = (raw7Res?.results ?? []) as Array<{
      model_id: number;
      gc_tps: string | null;
      gc_e2e: string | null;
      gc_ttft: string | null;
      gc_chunks: string | null;
      ok7: number | null;
      cnt: number | null;
    }>;

    const metaMap = new Map<
      number,
      { provider_model_id: string; display_name: string; provider: string }
    >();
    for (const r of metas) metaMap.set(r.id, r);
    const snapMap = new Map<number, (typeof snaps)[number]>();
    for (const r of snaps) snapMap.set(r.model_id, r);
    const r24Map = new Map<number, (typeof raw24)[number]>();
    for (const r of raw24) r24Map.set(r.model_id, r);
    const r7Map = new Map<number, (typeof raw7)[number]>();
    for (const r of raw7) r7Map.set(r.model_id, r);

    const median = (gc: string | null | undefined, cnt: number | null, min: number) =>
      (cnt ?? 0) >= min ? percentile(parseConcatNumbers(gc), 50) : null;

    const out: unknown[] = [];
    for (const id of ids) {
      const mm = metaMap.get(id);
      if (!mm) continue;
      const snap = snapMap.get(id);
      let tps_24h: number | null;
      let tps_7d: number | null;
      let e2e_tps_24h: number | null;
      let e2e_tps_7d: number | null;
      let ttft_24h: number | null;
      let ttft_7d: number | null;
      let uptime_7d: number | null;
      let error_rate: number | null;
      let median_chunks_7d: number | null;
      if (snap) {
        tps_24h = snap.tps_24h;
        tps_7d = snap.tps_7d;
        e2e_tps_24h = snap.e2e_tps_24h;
        e2e_tps_7d = snap.e2e_tps_7d;
        ttft_24h = snap.ttft_24h;
        ttft_7d = snap.ttft_7d;
        uptime_7d = snap.uptime_7d;
        error_rate = snap.error_rate_7d;
        median_chunks_7d = snap.median_chunks_7d;
      } else {
        const r24 = r24Map.get(id);
        const r7 = r7Map.get(id);
        tps_24h = median(r24?.gc_tps, r24?.cnt ?? null, MIN_SAMPLES.w24h);
        e2e_tps_24h = median(r24?.gc_e2e, r24?.cnt ?? null, MIN_SAMPLES.w24h);
        ttft_24h = median(r24?.gc_ttft, r24?.cnt ?? null, MIN_SAMPLES.w24h);
        tps_7d = median(r7?.gc_tps, r7?.cnt ?? null, MIN_SAMPLES.w7d);
        e2e_tps_7d = median(r7?.gc_e2e, r7?.cnt ?? null, MIN_SAMPLES.w7d);
        ttft_7d = median(r7?.gc_ttft, r7?.cnt ?? null, MIN_SAMPLES.w7d);
        uptime_7d =
          (r7?.cnt ?? 0) >= MIN_SAMPLES.w7d
            ? (r7?.ok7 ?? 0) / (r7?.cnt ?? 1)
            : null;
        error_rate = uptime_7d == null ? null : 1 - uptime_7d;
        median_chunks_7d =
          (r7?.ok7 ?? 0) >= MIN_SAMPLES.w7d
            ? percentile(parseConcatNumbers(r7?.gc_chunks), 50)
            : null;
      }
      out.push({
        model_id: id,
        provider: mm.provider,
        model: mm.provider_model_id,
        display_name: mm.display_name,
        tps_24h,
        tps_7d,
        e2e_tps_24h,
        e2e_tps_7d,
        ttft_24h,
        ttft_7d,
        uptime_7d,
        error_rate,
        median_chunks_7d,
      });
    }
    let recommended: unknown = null;
    if (out.length >= 2) {
      const sorted = [
        ...(out as Array<{ e2e_tps_7d: number | null; provider: string }>),
      ].sort((a, b) => (b.e2e_tps_7d ?? -1) - (a.e2e_tps_7d ?? -1));
      recommended = sorted[0]?.provider ?? null;
    }
    const resp = c.json({ compare: out, recommended_provider: recommended });
    resp.headers.set(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=300",
    );
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    } catch {
      // cache put best-effort
    }
    return resp;
  });
  return r;
}
