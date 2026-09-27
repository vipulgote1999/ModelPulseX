# BUG-2026-09-27 — Dashboard page scrolls horizontally

**Severity:** low · **Priority:** medium · **Scope:** `frontend/src/App.tsx`, `frontend/src/components/Leaderboard.tsx`

## Symptom

Live dashboard shows a page-level right/horizontal scrollbar (leaderboard
table region wider than the viewport on narrower screens).

## Root cause

1. App root (`min-h-screen` div) has no horizontal overflow guard, so any
   wide child (wide data table, `overflow-visible` sparklines) can push the
   whole page wider than the viewport.
2. Leaderboard table wrapper uses bare `overflow-auto` (both axes).

## Fix (minimum, CSS-only)

1. Root div += `overflow-x-clip`: the page can never scroll horizontally;
   `clip` (not `hidden`) so no scroll container is created and sticky
   positioning keeps working.
2. Table wrapper `overflow-auto` → `overflow-x-auto`: the wide table still
   scrolls *inside its card* on small screens instead of moving the page.

## Verification

- [ ] `tsc`, `vitest`, `eslint` green
- [ ] `vite build` + `wrangler deploy`, no page-level horizontal scrollbar
      at 1280px and 390px widths; table scrolls inside its card only
