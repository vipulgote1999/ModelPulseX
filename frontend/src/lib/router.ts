// Shareable hash routes + compare-URL helpers (e04s04 TokenDyno parity).
// Pure module: covered by test/router.test.ts. App owns hash writes;
// pages read through here so routes never drift per call site.

export type Page =
  | "dashboard"
  | "models"
  | "model"
  | "pricing"
  | "vs"
  | "methodology"
  | "docs"
  | "admin";

export type TpsView = "both" | "e2e" | "decode";

export interface Route {
  page: Page;
  /** Model id for the model detail page; null otherwise. */
  modelId: number | null;
  /** Compare selection ids (dashboard only); deduped positive ints, max 6. */
  compare: number[];
  /** Leaderboard throughput view (dashboard only); absent means "both". */
  tpsView?: TpsView;
}

/** Max pinned models for comparison (TokenDyno allows 6). */
export const MAX_COMPARE = 6;

export function parseCompareIds(raw: string | null): number[] {
  if (raw == null || raw === "") return [];
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0 && out.indexOf(n) < 0) out.push(n);
    if (out.length >= MAX_COMPARE) break;
  }
  return out;
}

export function parseHash(hash: string): Route {
  const base: Route = { page: "dashboard", modelId: null, compare: [] };
  const h = hash.charAt(0) === "#" ? hash.slice(1) : hash;
  const q = h.indexOf("?");
  const path = q < 0 ? h : h.slice(0, q);
  const query = q < 0 ? "" : h.slice(q + 1);
  const params = new URLSearchParams(query);
  if (path === "" || path === "/") {
    const route: Route = {
      page: "dashboard",
      modelId: null,
      compare: parseCompareIds(params.get("compare")),
    };
    const view = params.get("tps_view");
    // Junk is dropped rather than becoming a third state the UI must explain.
    if (view === "e2e" || view === "decode") route.tpsView = view;
    return route;
  }
  if (path === "/models") return { page: "models", modelId: null, compare: [] };
  if (path === "/pricing") return { page: "pricing", modelId: null, compare: [] };
  if (path === "/vs") return { page: "vs", modelId: null, compare: [] };
  if (path === "/methodology") return { page: "methodology", modelId: null, compare: [] };
  if (path === "/docs") return { page: "docs", modelId: null, compare: [] };
  if (path === "/admin") return { page: "admin", modelId: null, compare: [] };
  const modelMatch = /^\/model\/(\d+)$/.exec(path);
  if (modelMatch) {
    const id = Number(modelMatch[1]);
    if (Number.isInteger(id) && id > 0) return { page: "model", modelId: id, compare: [] };
  }
  return base;
}

export function formatHash(route: Route): string {
  if (route.page === "dashboard") {
    const parts: string[] = [];
    if (route.compare.length > 0) parts.push("compare=" + route.compare.join(","));
    // "both" is the default view, so only an explicit single-metric view
    // belongs in the URL.
    if (route.tpsView === "e2e" || route.tpsView === "decode")
      parts.push("tps_view=" + route.tpsView);
    return parts.length > 0 ? "#/?" + parts.join("&") : "#/";
  }
  if (route.page === "model")
    return route.modelId != null ? "#/model/" + route.modelId : "#/";
  return "#/" + route.page;
}
