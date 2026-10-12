import { useState } from "react";
import Logo from "./Logo";
import type { Page } from "../lib/router";

function initialTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export default function Header({
  onNavigate,
  current,
}: {
  onNavigate: (p: Exclude<Page, "model">) => void;
  current: Page;
}) {
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("mpx-theme", next);
    } catch {
      // private mode: theme still applies for this load
    }
    setTheme(next);
  };
  return (
    <header className="sticky top-0 z-40 backdrop-blur bg-[#0a0a0f]/80 border-b border-zinc-800">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo variant="full" size={36} />
          <span className="hidden md:inline text-[11px] tracking-widest text-zinc-400 font-medium">
            21 Providers — FREE MODELS{" "}
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
            onClick={() => onNavigate("models")}
            className={`px-3 py-1.5 rounded-md ${current === "models" || current === "model" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
          >
            Models
          </button>
          <button
            onClick={() => onNavigate("pricing")}
            className={`px-3 py-1.5 rounded-md ${current === "pricing" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
          >
            Pricing
          </button>
          <button
            onClick={() => onNavigate("vs")}
            className={`px-3 py-1.5 rounded-md ${current === "vs" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
          >
            vs Others
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
          <button
            onClick={toggleTheme}
            aria-pressed={theme === "light"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2.5v2.5M12 19v2.5M4.5 4.5l1.8 1.8M17.7 17.7l1.8 1.8M2.5 12H5M19 12h2.5M4.5 19.5l1.8-1.8M17.7 6.3l1.8-1.8" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 14.5A8 8 0 1 1 9.5 4a6.2 6.2 0 0 0 10.5 10.5Z" />
              </svg>
            )}
          </button>
        </nav>
      </div>
    </header>
  );
}
