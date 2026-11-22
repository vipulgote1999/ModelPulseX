import { useEffect, useState } from "react";
import Logo from "./Logo";
import type { Page } from "../lib/router";

type NavPage = Exclude<Page, "model">;

const NAV_ITEMS: Array<{ page: NavPage; label: string }> = [
  { page: "dashboard", label: "Dashboard" },
  { page: "models", label: "Models" },
  { page: "pricing", label: "Pricing" },
  { page: "vs", label: "vs Others" },
  { page: "docs", label: "Docs" },
  { page: "methodology", label: "/methodology" },
  { page: "admin", label: "Admin" },
];

function initialTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

export default function Header({
  onNavigate,
  current,
}: {
  onNavigate: (p: NavPage) => void;
  current: Page;
}) {
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  // Route changes come from the hash listener in App; close the sheet so a
  // back/forward gesture never leaves an open menu over the new page.
  useEffect(() => setMenuOpen(false), [current]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
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
  const active = (page: NavPage) =>
    page === "dashboard"
      ? current === "dashboard"
      : page === "models"
        ? current === "models" || current === "model"
        : current === page;
  const go = (page: NavPage) => {
    onNavigate(page);
    setMenuOpen(false);
  };
  const themeLabel =
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const themeIcon =
    theme === "dark" ? (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.5M12 19v2.5M4.5 4.5l1.8 1.8M17.7 17.7l1.8 1.8M2.5 12H5M19 12h2.5M4.5 19.5l1.8-1.8M17.7 6.3l1.8-1.8" />
      </svg>
    ) : (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 14.5A8 8 0 1 1 9.5 4a6.2 6.2 0 0 0 10.5 10.5Z" />
      </svg>
    );
  return (
    <header className="sticky top-0 z-40 backdrop-blur bg-[#0a0a0f]/80 border-b border-zinc-800">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Logo variant="full" size={36} />
          <span className="hidden md:inline text-[11px] tracking-widest text-zinc-400 font-medium whitespace-nowrap">
            21 Providers — FREE MODELS{" "}
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />{" "}
              LIVE
            </span>
          </span>
        </div>
        <nav
          aria-label="Main"
          className="hidden lg:flex items-center gap-2 text-sm"
        >
          {NAV_ITEMS.map((item) => (
            <button
              key={item.page}
              onClick={() => go(item.page)}
              aria-current={active(item.page) ? "page" : undefined}
              className={`px-3 py-1.5 rounded-md ${
                item.page === "admin"
                  ? `border ${active("admin") ? "bg-violet-600 text-white border-violet-600" : "text-zinc-400 hover:text-white border-zinc-800 hover:border-zinc-700"}`
                  : active(item.page)
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
          <a
            href="/api/health"
            target="_blank"
            rel="noreferrer"
            className="hidden xl:inline text-xs text-zinc-500 hover:text-zinc-300"
          >
            API →
          </a>
          <button
            onClick={toggleTheme}
            aria-pressed={theme === "light"}
            aria-label={themeLabel}
            title={themeLabel}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            {themeIcon}
          </button>
        </nav>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          className="lg:hidden p-2 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800"
        >
          {menuOpen ? (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          )}
        </button>
      </div>
      {menuOpen && (
        <div
          id="mobile-nav"
          className="lg:hidden border-t border-zinc-800 bg-[#0a0a0f]/95 px-4 sm:px-6 py-3"
        >
          <nav aria-label="Mobile" className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.page}
                onClick={() => go(item.page)}
                aria-current={active(item.page) ? "page" : undefined}
                className={`text-left px-3 py-2 rounded-md text-sm ${
                  active(item.page)
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-white hover:bg-zinc-900"
                }`}
              >
                {item.label}
              </button>
            ))}
            <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-zinc-800">
              <a
                href="/api/health"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                API health →
              </a>
              <button
                onClick={toggleTheme}
                aria-pressed={theme === "light"}
                aria-label={themeLabel}
                className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-md border border-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-800"
              >
                {themeIcon}
                {theme === "dark" ? "Light theme" : "Dark theme"}
              </button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
