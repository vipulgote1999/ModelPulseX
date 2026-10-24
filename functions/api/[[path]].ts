/**
 * Pages front-door API proxy — URL-001 (specs/pages-front-door-2026-09-28.md).
 *
 * The public hostname is `modelpulsex.pages.dev`. Everything that touches state
 * (cron, the bench-queue consumer, PerformanceDO, D1) stays in the Worker, reached
 * here over a service binding: an internal call that never crosses the internet and
 * never needs a public Worker hostname.
 *
 * DELIBERATELY a bare pass-through. Do not wrap the body:
 *
 *   - never `await res.text()` / `res.json()` / `new Response(await ...)`
 *   - never rebuild the Headers object by hand
 *
 * `/api/live` is a long-lived `text/event-stream` fed by the Durable Object.
 * Consuming the body before returning would hold every live connection open until
 * the stream ended — which for SSE is never. The dashboard would keep rendering and
 * every health check would still return 200 while the live leaderboard silently
 * stopped updating. Returning the Response object itself hands the stream straight
 * through, so frames keep flowing.
 */

export interface Env {
  /** Service binding to the Worker that owns all state. See wrangler.pages.jsonc. */
  API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  return env.API.fetch(request);
};
