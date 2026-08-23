import { useState } from "react";
import Header from "./components/Header";
import Dashboard from "./pages/Dashboard";
import Methodology from "./pages/Methodology";

export default function App() {
  const [page, setPage] = useState<"dashboard" | "methodology">("dashboard");
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100">
      <Header onNavigate={setPage} current={page} />
      {page === "dashboard" ? <Dashboard /> : <Methodology />}
      <footer className="border-t border-zinc-800 mt-10 py-6 text-center text-xs text-zinc-500">
        ModelPulseX — Measurements are streaming-derived; influenced by provider load, routing, time of day. <button onClick={() => setPage("methodology")} className="underline hover:text-zinc-300">Methodology</button>
      </footer>
    </div>
  );
}
