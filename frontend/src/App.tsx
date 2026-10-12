import { useState, lazy, Suspense, useEffect, useCallback } from "react";
import Header from "./components/Header";
import Logo from "./components/Logo";
import Dashboard from "./pages/Dashboard";
import { parseHash, formatHash, type Page, type Route } from "./lib/router";
const Methodology = lazy(() => import("./pages/Methodology"));
const Admin = lazy(() => import("./pages/Admin"));
const Docs = lazy(() => import("./pages/Docs"));
const Models = lazy(() => import("./pages/Models"));
const Pricing = lazy(() => import("./pages/Pricing"));
const ModelDetail = lazy(() => import("./pages/ModelDetail"));

/** Top-level pages reachable from the nav (model detail is link-only). */
export type NavPage = Exclude<Page, "model">;

function routeFromHash(): Route {
  return parseHash(window.location.hash);
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeFromHash());
  useEffect(() => {
    const onChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  // Nav keeps the dashboard compare selection in the URL when staying on or
  // returning to the dashboard; other pages start clean.
  const navigate = useCallback((page: NavPage) => {
    if (page === "dashboard") {
      const cur = parseHash(window.location.hash);
      window.location.hash = formatHash({ page, modelId: null, compare: cur.compare });
    } else {
      window.location.hash = formatHash({ page, modelId: null, compare: [] });
    }
  }, []);
  // Pages landing in later e04s04 commits fall back to the dashboard until
  // their route branch exists below (never a dead link: nav only lists live pages).
  const page = route.page === "vs" ? "dashboard" : route.page;
  return (
    <div className="min-h-screen overflow-x-clip bg-[#0a0a0f] text-zinc-100">
      <Header onNavigate={navigate} current={route.page} />
      <Suspense
        fallback={
          <div className="max-w-[1400px] mx-auto px-4 py-10 text-zinc-400 animate-pulse">
            Loading…
          </div>
        }
      >
        {page === "dashboard" ? (
          <Dashboard />
        ) : page === "models" ? (
          <Models />
        ) : page === "model" ? (
          <ModelDetail modelId={route.modelId ?? -1} />
        ) : page === "pricing" ? (
          <Pricing />
        ) : page === "admin" ? (
          <Admin />
        ) : page === "docs" ? (
          <Docs />
        ) : (
          <Methodology />
        )}
      </Suspense>
      <footer className="border-t border-zinc-800 mt-10 py-6 text-center text-xs text-zinc-500">
        <span className="inline-flex items-center gap-2 text-zinc-400">
          <Logo variant="mark" size={18} withTile={false} label="ModelPulseX" />
          <span>
            ModelPulseX — Measurements are streaming-derived; influenced by
            provider load, routing, time of day.
          </span>
        </span>{" "}
        <button
          onClick={() => navigate("methodology")}
          className="underline hover:text-zinc-300"
        >
          Methodology
        </button>
      </footer>
    </div>
  );
}
