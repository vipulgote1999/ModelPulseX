#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const LIVE = "https://modelpulsex.vipulgote5.workers.dev";
const OUT = path.join(
  process.cwd(),
  "dump",
  `pw-live-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
);
fs.mkdirSync(OUT, { recursive: true });
console.log(`→ OUT: ${OUT}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  userAgent: "ModelPulseX-Playwright-Audit",
});
const page = await context.newPage();

const consoleLogs = [];
const pageErrors = [];
const requests = [];
const responses = [];

page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("request", (r) =>
  requests.push({ url: r.url(), method: r.method(), t: Date.now() }),
);
page.on("response", async (r) => {
  try {
    const url = r.url();
    if (url.includes("/api/")) {
      const body = await r.text().catch(() => "<no body>");
      responses.push({
        url,
        status: r.status(),
        headers: Object.fromEntries(Object.entries(r.headers())),
        bodySnippet: body.slice(0, 4000),
        t: Date.now(),
      });
    }
  } catch (e) {
    responses.push({ url: r.url(), status: r.status(), err: String(e) });
  }
});

const timings = {};
async function measureFetch(url, label) {
  const t0 = Date.now();
  try {
    const r = await page.evaluate(async (u) => {
      const t0 = performance.now();
      const res = await fetch(u);
      const t1 = performance.now();
      const text = await res.text();
      return {
        status: res.status,
        ms: Math.round(t1 - t0),
        headers: Object.fromEntries(res.headers.entries()),
        body: text.slice(0, 8000),
      };
    }, url);
    const dt = Date.now() - t0;
    timings[label] = { ...r, totalMs: dt };
    console.log(
      `  ↳ ${label}: ${r.status} in ${r.ms}ms (total ${dt}ms) ${url}`,
    );
    fs.writeFileSync(
      path.join(OUT, `${label}.json`),
      JSON.stringify(r, null, 2),
    );
    return r;
  } catch (e) {
    timings[label] = { error: String(e), totalMs: Date.now() - t0 };
    console.log(`  ✗ ${label} failed: ${e}`);
  }
}

console.log(`→ Navigating to ${LIVE}`);
const navStart = Date.now();
await page.goto(LIVE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page
  .waitForLoadState("networkidle", { timeout: 15000 })
  .catch(() => console.log("  ⚠ networkidle timeout"));
const navMs = Date.now() - navStart;
console.log(`  ✓ nav ${navMs}ms, title: ${await page.title()}`);
await page.waitForTimeout(2500);

// screenshot 1: full page
await page.screenshot({ path: path.join(OUT, "01-full.png"), fullPage: true });
console.log("  📸 01-full.png");
// screenshot 2: viewport
await page.screenshot({
  path: path.join(OUT, "02-viewport.png"),
  fullPage: false,
});

// dump DOM info
const domInfo = await page.evaluate(() => {
  const info = {};
  info.title = document.title;
  info.leaderboardRows = document.querySelectorAll("table tbody tr").length;
  info.leaderboardHeaders = Array.from(
    document.querySelectorAll("table thead th"),
  ).map((e) => e.textContent.trim().slice(0, 40));
  info.chartContainers = document.querySelectorAll(
    '[class*="recharts"]',
  ).length;
  info.svgCount = document.querySelectorAll("svg").length;
  info.chartEmptyMessages = Array.from(document.querySelectorAll("div"))
    .map((d) => d.textContent.trim())
    .filter((t) =>
      /Select models|no hourly samples|Loading chart|TPS.*median/i.test(t),
    )
    .slice(0, 10);
  info.freshnessBanner =
    document
      .querySelector("div.rounded-lg.border")
      ?.textContent.slice(0, 300) ?? null;
  info.summaryCards = Array.from(
    document.querySelectorAll('[class*="rounded-xl"]'),
  )
    .slice(0, 5)
    .map((e) => e.textContent.slice(0, 120));
  info.networkErrorBanner =
    Array.from(document.querySelectorAll("div"))
      .map((d) => d.textContent)
      .find((t) => /Failed to load|STALE DATA/i.test(t))
      ?.slice(0, 500) ?? null;
  // check history fetch correlation: look for selected models
  info.selectedText = document.body.innerText.slice(0, 4000);
  // find TpsChart title
  info.tpsTitles = Array.from(document.querySelectorAll("div"))
    .filter((d) => d.textContent.includes("TPS"))
    .map((d) => d.textContent.slice(0, 150))
    .slice(0, 5);
  info.relia = Array.from(document.querySelectorAll("div"))
    .filter((d) => d.textContent.includes("Reliability"))
    .map((d) => d.textContent.slice(0, 150))
    .slice(0, 3);
  info.errors = [];
  // check if recharts responsive container has 0 height
  const rc = document.querySelector(".recharts-responsive-container");
  info.rechartsContainer = rc
    ? {
        w: rc.clientWidth,
        h: rc.clientHeight,
        html: rc.innerHTML.slice(0, 2000),
      }
    : null;
  info.allRecharts = Array.from(document.querySelectorAll(".recharts-wrapper"))
    .map((e) => ({ w: e.clientWidth, h: e.clientHeight }))
    .slice(0, 5);
  return info;
});
console.log("  DOM:", JSON.stringify(domInfo, null, 2));
fs.writeFileSync(path.join(OUT, "dom.json"), JSON.stringify(domInfo, null, 2));

// Try clicking a leaderboard row to trigger chart update
try {
  const rows = page.locator("table tbody tr");
  const count = await rows.count();
  console.log(`  leaderboard rows: ${count}`);
  if (count > 0) {
    await rows.first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: path.join(OUT, "03-after-click.png"),
      fullPage: true,
    });
    console.log("  📸 03-after-click.png");
    const after = await page.evaluate(() => {
      return {
        chartContainers: document.querySelectorAll('[class*="recharts"]')
          .length,
        svgCount: document.querySelectorAll("svg").length,
        chartTexts: Array.from(document.querySelectorAll("div"))
          .map((d) => d.textContent.trim())
          .filter((t) => /Select models|no hourly/i.test(t))
          .slice(0, 5),
        recharts:
          document
            .querySelector(".recharts-wrapper")
            ?.innerHTML.slice(0, 1500) ?? null,
      };
    });
    console.log("  after click:", JSON.stringify(after, null, 2));
    fs.writeFileSync(
      path.join(OUT, "after-click.json"),
      JSON.stringify(after, null, 2),
    );
  }
} catch (e) {
  console.log("  click failed", e);
}

// Measure API timings via page fetch (same origin, so CORS not blocking)
await measureFetch(`${LIVE}/api/health`, "health");
await measureFetch(`${LIVE}/api/providers`, "providers");
await measureFetch(`${LIVE}/api/leaderboard?range=7d`, "leaderboard-7d");
await measureFetch(`${LIVE}/api/leaderboard?range=24h`, "leaderboard-24h");
await measureFetch(`${LIVE}/api/leaderboard?range=1h`, "leaderboard-1h");
await measureFetch(`${LIVE}/api/models`, "models");

// Try to discover model IDs from leaderboard for history test
let sampleIds = [];
try {
  const lb = JSON.parse(timings["leaderboard-7d"]?.body ?? "{}");
  const rows = lb.leaderboard ?? [];
  sampleIds = rows.slice(0, 3).map((r) => r.model_id);
  console.log(`  sampleIds: ${sampleIds.join(",")}`);
  fs.writeFileSync(
    path.join(OUT, "leaderboard.json"),
    JSON.stringify(lb, null, 2),
  );
} catch (e) {
  console.log("  parse leaderboard failed", e);
}

if (sampleIds.length) {
  await measureFetch(
    `${LIVE}/api/history?ids=${sampleIds.join(",")}&range=7d`,
    "history-7d",
  );
  await measureFetch(
    `${LIVE}/api/history?ids=${sampleIds.join(",")}&range=24h`,
    "history-24h",
  );
  await measureFetch(
    `${LIVE}/api/history?ids=${sampleIds.join(",")}&range=1h`,
    "history-1h",
  );
  for (const id of sampleIds.slice(0, 2)) {
    await measureFetch(
      `${LIVE}/api/models/${id}/history?range=7d`,
      `model-${id}-history`,
    );
    await measureFetch(
      `${LIVE}/api/models/${id}/incidents`,
      `model-${id}-incidents`,
    );
  }
} else {
  await measureFetch(
    `${LIVE}/api/history?ids=1,2,3&range=7d`,
    "history-fallback",
  );
}

// Security probe: headers + CORS + admin without auth
await measureFetch(`${LIVE}/api/admin/models`, "admin-noauth");
const corsProbe = await page.evaluate(async (u) => {
  // try cross-origin-like fetch with Origin header via page (will be same origin, but check Access-Control-Allow-Origin)
  const r = await fetch(u);
  return { headers: Object.fromEntries(r.headers.entries()), status: r.status };
}, `${LIVE}/api/leaderboard?range=7d`);
fs.writeFileSync(
  path.join(OUT, "cors-check.json"),
  JSON.stringify(corsProbe, null, 2),
);

// Check frontend JS bundles: look for sourcemap exposure, etc.
const jsUrls = await page.evaluate(() =>
  Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src)
    .slice(0, 10),
);
console.log("  jsUrls", jsUrls);
fs.writeFileSync(
  path.join(OUT, "jsUrls.json"),
  JSON.stringify(jsUrls, null, 2),
);

// Collect logs
fs.writeFileSync(
  path.join(OUT, "console.json"),
  JSON.stringify(consoleLogs, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "pageErrors.json"),
  JSON.stringify(pageErrors, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "responses.json"),
  JSON.stringify(responses, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "timings.json"),
  JSON.stringify(timings, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "requests.json"),
  JSON.stringify(requests, null, 2),
);

// Final full page content dump
const html = await page.content();
fs.writeFileSync(path.join(OUT, "page.html"), html);

console.log(`\n✓ Done → ${OUT}`);
console.log(
  `  console logs: ${consoleLogs.length}, pageErrors: ${pageErrors.length}, api responses: ${responses.length}`,
);
await browser.close();
