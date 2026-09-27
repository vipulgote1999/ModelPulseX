import Logo from "./Logo";

export default function Header({
  onNavigate,
  current,
}: {
  onNavigate: (p: "dashboard" | "methodology" | "admin" | "docs") => void;
  current: string;
}) {
  return (
    <header className="sticky top-0 z-40 backdrop-blur bg-[#0a0a0f]/80 border-b border-zinc-800">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo variant="full" size={36} />
          <span className="hidden md:inline text-[11px] tracking-widest text-zinc-400 font-medium">
            19 Providers — FREE MODELS{" "}
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />{" "}
              LIVE
            </span>
          </span>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <button
            onClick={() => onNavigate("dashboard")}
            className={`px-3 py-1.5 rounded-md ${current === "dashboard" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
          >
            Dashboard
          </button>
          <button
            onClick={() => onNavigate("docs")}
            className={`px-3 py-1.5 rounded-md ${current === "docs" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
          >
            Docs
          </button>
          <button
            onClick={() => onNavigate("methodology")}
            className={`px-3 py-1.5 rounded-md ${current === "methodology" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
          >
            /methodology
          </button>
          <button
            onClick={() => onNavigate("admin")}
            className={`px-3 py-1.5 rounded-md border ${current === "admin" ? "bg-violet-600 text-white border-violet-600" : "text-zinc-400 hover:text-white border-zinc-800 hover:border-zinc-700"}`}
          >
            Admin
          </button>
          <a
            href="/api/health"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline text-xs text-zinc-500 hover:text-zinc-300"
          >
            API →
          </a>
        </nav>
      </div>
    </header>
  );
}
