export default function Header({ onNavigate, current }: { onNavigate: (p: "dashboard" | "methodology") => void; current: string }) {
  return (
    <header className="sticky top-0 z-40 backdrop-blur bg-[#0a0a0f]/80 border-b border-zinc-800">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 grid place-items-center font-bold text-white">◆</div>
          <div>
            <div className="font-semibold tracking-tight leading-none text-[15px]">LLM PERFORMANCE OBSERVATORY</div>
            <div className="text-[11px] tracking-widest text-zinc-400 font-medium">18 Providers — FREE MODELS <span className="inline-flex items-center gap-1 text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" /> LIVE</span></div>
          </div>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <button onClick={() => onNavigate("dashboard")} className={`px-3 py-1.5 rounded-md ${current === "dashboard" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}>Dashboard</button>
          <button onClick={() => onNavigate("methodology")} className={`px-3 py-1.5 rounded-md ${current === "methodology" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}>/methodology</button>
          <a href="/api/health" target="_blank" rel="noreferrer" className="hidden sm:inline text-xs text-zinc-500 hover:text-zinc-300">API →</a>
        </nav>
      </div>
    </header>
  );
}
