import { useState, lazy, Suspense } from "react";
import Header from "./components/Header";
import Logo from "./components/Logo";
import Dashboard from "./pages/Dashboard";
const Methodology = lazy(() => import("./pages/Methodology"));
const Admin = lazy(() => import("./pages/Admin"));
const Docs = lazy(() => import("./pages/Docs"));

export default function App() {
  const [page, setPage] = useState<"dashboard" | "methodology" | "admin" | "docs">(
    "dashboard",
  );
  return (
    <div className="min-h-screen overflow-x-clip bg-[#0a0a0f] text-zinc-100">
      <Header onNavigate={setPage} current={page} />
      <Suspense
        fallback={
          <div className="max-w-[1400px] mx-auto px-4 py-10 text-zinc-400 animate-pulse">
            Loading…
          </div>
        }
      >
        {page === "dashboard" ? (
          <Dashboard />
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
          onClick={() => setPage("methodology")}
          className="underline hover:text-zinc-300"
        >
          Methodology
        </button>
      </footer>
    </div>
  );
}
