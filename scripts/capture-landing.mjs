// Capture landing-page video + section screenshots for UX review.
// Usage: node scripts/capture-landing.mjs [baseUrl] [outDir]
import { chromium } from "playwright";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8787";
const outDir = process.argv[3] ?? "performance_report/landing-capture";
const { mkdirSync } = await import("node:fs");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60000 });
// Wait for app to render (leaderboard or loading state resolves)
await page.waitForTimeout(4000);
await page.screenshot({ path: `${outDir}/01-hero.png` });

// Slow scroll through the whole page in steps so the video tours every section
const steps = 24;
for (let i = 1; i <= steps; i++) {
  await page.evaluate((f) => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: (h * f) / 24, behavior: "smooth" });
  }, i);
  await page.waitForTimeout(500);
  // Section screenshots at ~1/4 (rec cards), ~1/2 (leaderboard), ~3/4 (TPS chart)
  if (i === 6) await page.screenshot({ path: `${outDir}/02-best-models.png` });
  if (i === 12) await page.screenshot({ path: `${outDir}/03-leaderboard.png` });
  if (i === 18) await page.screenshot({ path: `${outDir}/04-tps-graph.png` });
}
await page.screenshot({ path: `${outDir}/05-bottom.png`, fullPage: false });
// Full-page still for layout review
await page.screenshot({ path: `${outDir}/00-fullpage.png`, fullPage: true });

const videoPath = await page.video()?.path();
console.log("VIDEO:", videoPath);
console.log("CONSOLE_ERRORS:", JSON.stringify(errors.slice(0, 10)));
await context.close();
await browser.close();
