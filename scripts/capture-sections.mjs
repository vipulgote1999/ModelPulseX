// Targeted section screenshots of prod landing page.
// Usage: node scripts/capture-sections.mjs
import { chromium } from "playwright";

const baseUrl = "https://modelpulsex.vipulgote5.workers.dev/";
const outDir = "performance_report/landing-capture-prod-01";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(4000);

// Top of leaderboard (rank 1+)
await page.getByText("Live leaderboard").scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/10-leaderboard-top.png` });

// Chart model selector + TPS chart
await page.getByText("Graph comparison — pick up to 3 models").scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/11-selector.png` });
await page.getByText("7-day TPS (median per hour)").scrollIntoViewIfNeeded();
await page.waitForTimeout(2500); // let lazy recharts chunk load + render
await page.screenshot({ path: `${outDir}/12-tps-chart.png` });
await browser.close();
console.log("done");
