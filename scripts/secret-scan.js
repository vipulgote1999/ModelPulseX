// scripts/secret-scan.js — pre-commit secret scan (lightweight gitleaks alternative without binary)
// Usage: node scripts/secret-scan.js  (exit 1 if suspected secret found)
import fs from "fs";
import { execSync } from "child_process";
const patterns = [
  /sk-(or|proj|live)-[A-Za-z0-9]{20,}/,
  /gsk_[A-Za-z0-9]{20,}/,
  /csk-[A-Za-z0-9_-]{20,}/,
  /nvapi-[A-Za-z0-9_-]{20,}/,
  /AQ\.[A-Za-z0-9_-]{30,}/,
  /cfut_[A-Za-z0-9_-]{20,}/,
  /ADMIN_TOKEN\s*=\s*['"][A-Za-z0-9]{16,}['"]/,
  /OPENROUTER_API_KEY\s*=\s*.{10,}/,
];
let found = false;
try {
  const diff = execSync("git diff --cached --unified=0 2>&1", { encoding: "utf8" });
  // Also scan staged file names for .env
  const staged = execSync("git diff --cached --name-only 2>&1", { encoding: "utf8" });
  if (staged.split("\n").some((f) => f.trim() === ".env" || f.trim() === ".dev.vars")) {
    console.error("BLOCKED: .env / .dev.vars are staged — unstage and use wrangler secret put instead");
    found = true;
  }
  for (const pat of patterns) {
    if (pat.test(diff)) {
      console.error("BLOCKED: suspected secret pattern", pat, "in staged diff");
      found = true;
    }
  }
  // Also scan file content direct
  const files = staged.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, "utf8");
      for (const pat of patterns) if (pat.test(content)) { console.error("BLOCKED secret in", f, pat); found = true; }
    } catch {}
  }
} catch (e) { console.error("scan error", e.message); }
if (found) { console.error("\nFix: remove secrets, use wrangler secret put, then commit again."); process.exit(1); }
console.log("secret-scan: ok");
