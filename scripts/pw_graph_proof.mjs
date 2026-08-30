#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const LIVE = "https://modelpulsex.vipulgote5.workers.dev";
const OUT = path.join(
  process.cwd(),
  "dump",
  `pw-graph-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
);
fs.mkdirSync(OUT, { recursive: true });
console.log(`→ ${OUT}`);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
});
const page = await ctx.newPage();

// capture requests
page.on("response", async (r) => {
  if (
    r.url().includes("/api/history") ||
    r.url().includes("/api/leaderboard")
  ) {
    try {
      const t = await r.text().catch(() => "");
      const u = new URL(r.url());
      fs.writeFileSync(
        path.join(
          OUT,
          `resp-${u.pathname.replace(/\//g, "_")}-${Date.now()}.json`,
        ),
        JSON.stringify(
          { url: r.url(), status: r.status(), body: t.slice(0, 12000) },
          null,
          2,
        ),
      );
    } catch {}
  }
});

await page.goto(LIVE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2000);

// Get top healthy model ids via leaderboard API
const lb = await page.evaluate(async () => {
  const r = await fetch("/api/leaderboard?range=7d");
  const j = await r.json();
  return j.leaderboard
    .slice(0, 15)
    .map((m) => ({
      id: m.model_id,
      name: m.display_name,
      provider: m.provider,
      tps7d: m.tps_7d,
      up: m.uptime_7d,
      status: m.status,
    }));
});
console.log("top 15", JSON.stringify(lb, null, 2));
fs.writeFileSync(path.join(OUT, "lb-top15.json"), JSON.stringify(lb, null, 2));

// Find healthy ones with tps7d not null and uptime >0.5
const healthy = lb.filter((m) => m.tps7d != null && m.up > 0.5).slice(0, 4);
console.log("healthy", healthy);
if (healthy.length === 0)
  console.log("⚠ no healthy found, picking top3 anyway");

// Now test history API directly for healthy IDs
for (const m of healthy.slice(0, 3)) {
  const hist = await page.evaluate(async (id) => {
    const t0 = performance.now();
    const r = await fetch(`/api/models/${id}/history?range=7d`);
    const t1 = performance.now();
    const j = await r.json();
    return {
      status: r.status,
      ms: Math.round(t1 - t0),
      len: (j.history || []).length,
      sample: j.history.slice(0, 3),
      meta: j.meta,
    };
  }, m.id);
  console.log(
    `model ${m.id} ${m.name} hist len ${hist.len} ms ${hist.ms}`,
    JSON.stringify(hist.sample, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `hist-model-${m.id}.json`),
    JSON.stringify(hist, null, 2),
  );
  const batch = await page.evaluate(
    async (ids) => {
      const r = await fetch(`/api/history?ids=${ids.join(",")}&range=7d`);
      const j = await r.json();
      return { status: r.status, history: j.history, meta: j.meta };
    },
    [m.id],
  );
  console.log(
    `batch hist for ${m.id}`,
    JSON.stringify(Object.keys(batch.history), null, 2),
    JSON.stringify(Object.values(batch.history)[0]?.slice(0, 2), null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `batch-${m.id}.json`),
    JSON.stringify(batch, null, 2),
  );
}

// Now test UI selection of a healthy model: click leaderboard row containing healthy name
if (healthy.length) {
  const target = healthy[0].name.slice(0, 15);
  console.log(`→ clicking row containing "${target}"`);
  // find row
  const rows = page.locator("table tbody tr");
  const count = await rows.count();
  console.log(`rows ${count}`);
  for (let i = 0; i < count; i++) {
    const txt = await rows.nth(i).innerText();
    if (txt.includes(target.slice(0, 8))) {
      console.log(`clicking row ${i}: ${txt.slice(0, 120)}`);
      await rows.nth(i).click();
      await page.waitForTimeout(1500);
      break;
    }
  }
  // Also clear the default dead selection and pick healthy via dropdown
  // Use the ChartModelSelector: there are 3 selects — we can set via page.evaluate
  const selInfo = await page.evaluate(() => {
    // try to find select elements for chart comparison
    const selects = Array.from(document.querySelectorAll("select"));
    return selects.map((s) => ({
      opts: Array.from(s.options)
        .slice(0, 5)
        .map((o) => o.text.slice(0, 40)),
      val: s.value,
    }));
  });
  console.log("selects", JSON.stringify(selInfo, null, 2));

  // directly set selected via evaluating React? Instead use the UI: chartModelSelector has 3 dropdowns.
  // Let's try to set via DOM + dispatch change
  const charts = page.locator("text=7-day TPS").first();
  await charts.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(OUT, `before-manual-select.png`),
    fullPage: true,
  });
  // Now manipulate Dashboard state by clicking ComparePanel? Simpler: use page.evaluate to fetch and log what TpsChart receives
  const chartData = await page.evaluate(() => {
    // find if any line rendered: check SVG paths
    const paths = Array.from(document.querySelectorAll("svg path"));
    return {
      pathCount: paths.length,
      pathD: paths
        .slice(0, 2)
        .map((p) => (p.getAttribute("d") || "").slice(0, 200)),
      tpsTitle: document.body.innerText.includes("7-day TPS"),
    };
  });
  console.log("chartData after healthy click", chartData);
  fs.writeFileSync(
    path.join(OUT, "chartData.json"),
    JSON.stringify(chartData, null, 2),
  );
  await page.screenshot({
    path: path.join(OUT, `after-healthy-click.png`),
    fullPage: true,
  });
  console.log("📸 screenshots saved");
}

// Test 1h/24h history for granularity: check how many points per day
for (const range of ["1h", "24h", "3d", "7d"]) {
  const r = await page.evaluate(async (rng) => {
    const lbR = await fetch(`/api/leaderboard?range=${rng}`);
    const lbJ = await lbR.json();
    const id =
      lbJ.leaderboard.find((m) => m.tps_7d != null)?.model_id ??
      lbJ.leaderboard[0]?.model_id;
    if (!id) return { error: "no id" };
    const hR = await fetch(`/api/history?ids=${id}&range=${rng}`);
    const hJ = await hR.json();
    const hist = hJ.history[String(id)] ?? hJ.history[id] ?? [];
    // also compute benchmark_runs direct via /api/models/:id/history
    const mR = await fetch(`/api/models/${id}/history?range=${rng}`);
    const mJ = await mR.json();
    return {
      id,
      range: rng,
      batchLen: hist.length,
      rawLen: (mJ.history || []).length,
      sampleBatch: hist.slice(0, 2),
      sampleRaw: (mJ.history || []).slice(0, 2),
      metaBatch: hJ.meta,
      metaRaw: mJ.meta,
    };
  }, range);
  console.log(`range ${range}:`, JSON.stringify(r, null, 2));
  fs.writeFileSync(
    path.join(OUT, `range-${range}.json`),
    JSON.stringify(r, null, 2),
  );
}

await browser.close();
console.log("✓ done");
