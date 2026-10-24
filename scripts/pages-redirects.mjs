/**
 * Manages the Pages-only `_redirects` file in the shared build output
 * (URL-001, specs/pages-front-door-2026-09-28.md).
 *
 *   node scripts/pages-redirects.mjs write   # before `wrangler pages deploy`
 *   node scripts/pages-redirects.mjs clean   # before `wrangler deploy`
 *
 * WHY THIS IS NEEDED. `dist/frontend` is uploaded by BOTH deployments, and the file
 * must exist for exactly one of them:
 *
 *   - Pages needs `/* /index.html 200` for SPA client-side routing (/models/123).
 *   - Workers static assets VALIDATE `_redirects` and reject that same rule as an
 *     infinite loop (API error 100324). Workers gets SPA fallback from
 *     `assets.not_found_handling` in wrangler.jsonc instead, so it must NOT see
 *     this file.
 *
 * `dist/` persists between commands, so whichever deploy ran last leaves the file
 * in a state that breaks the other. Hence both deploy scripts bracket themselves
 * with the correct mode, making the order irrelevant.
 *
 * Chosen over `.assetsignore` because the precedence of that file between the two
 * asset pipelines is undocumented.
 */
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
const FILE = join(process.cwd(), "dist", "frontend", "_redirects");

if (mode === "clean") {
  if (existsSync(FILE)) {
    rmSync(FILE);
    console.log("[pages-redirects] removed dist/frontend/_redirects (Workers-safe)");
  }
  process.exit(0);
}

if (mode !== "write") {
  console.error("usage: node scripts/pages-redirects.mjs <write|clean>");
  process.exit(1);
}

const body = `# SPA fallback for client-side routes (/models/123, /docs), which have no
# file on disk. Written by scripts/pages-redirects.mjs at Pages deploy time and
# removed again before any Worker deploy, because Workers static assets reject
# this rule as an infinite loop (error 100324).
#
# Safe alongside functions/api/[[path]].ts: per Cloudflare's docs, "Redirects
# defined in the _redirects file are not applied to requests served by Pages
# Functions, even if the Function route matches the URL pattern."
/*  /index.html  200
`;

writeFileSync(FILE, body, "utf8");
console.log("[pages-redirects] wrote dist/frontend/_redirects (Pages deploy)");
