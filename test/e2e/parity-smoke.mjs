#!/usr/bin/env node
/**
 * E2E parity gate for the TokenDyno-parity epic (e04).
 *
 * Runs the real dist/frontend bundle in headless Chromium against an in-process
 * mock of the /api surface (same pattern as dashboard-smoke.mjs: no D1, no DO,
 * no network). Fails non-zero when any parity surface regresses:
 * dashboard Rel-24h/thinking/intelligence, 6-pin compare with shareable URL,
 * models catalog, model detail (stats/charts/404), pricing, vs page,
 * light/dark theme toggle with persistence.
 *
 * Usage: npm run build first, then npm run test:e2e:parity.
 */
/* global window, document */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DIST = join(ROOT, "dist", "frontend");
const SHOT_DIR = join(ROOT, "dump", "e2e");

const HOUR = 3600_000;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();

// Fixture ids deliberately match frontend/src/lib/intelligence.ts aliases so
// thinking/intelligence assertions exercise the real metadata table.
const MODELS = [
  { model_id: 1, model: "kimi-k3", display_name: "Kimi K3", provider: "groq" },
  { model_id: 2, model: "nemotron-3-nano:30b", display_name: "Nemotron 3 Nano", provider: "ollama" },
  { model_id: 3, model: "gpt-oss:20b", display_name: "GPT OSS 20B", provider: "ollama" },
  { model_id: 4, model: "glm-5.3", display_name: "GLM 5.3", provider: "openrouter" },
  { model_id: 5, model: "step-5-preview-free", display_name: "Step 5 Preview", provider: "opencode_go" },
  { model_id: 6, model: "mimo-v2.6-flash-free", display_name: "MiMo Flash", provider: "opencode_zen" },
];

function leaderboardRows() {
  return MODELS.map((m, i) => ({
    rank: i + 1,
    model_id: m.model_id,
    model: m.model,
    display_name: m.display_name,
    provider: m.provider,
    free_status: "FREE",
    active: true,
    tps_now: 100 - i * 7,
    tps_1h: 99 - i * 7,
    tps_24h: 98 - i * 7,
    tps_7d: 97 - i * 7,
    ttft_now: 200 + i * 40,
    ttft_7d: 220 + i * 40,
    itl_now: 12 + i,
    itl_7d: 13 + i,
    uptime_7d: 0.99,
    uptime_24h: 0.95 - i * 0.01,
    error_rate_7d: 0.01,
    status: "SUCCESS",
    last_test: iso(60_000),
    overall_score: 90 - i * 3,
    sampleCount24h: 12,
    measured_tps_label: "Measured TPS",
    sparkline: Array.from({ length: 24 }, (_, h) => 90 - i * 7 + (h % 5)),
  }));
}

function leaderboardBody() {
  const rows = leaderboardRows();
  return {
    leaderboard: rows,
    range: "7d",
    benchmark: "coding",
    sort: "overall",
    profile: "balanced",
    meta: { last_benchmark: iso(60_000), last_aggregate: iso(90_000), last_discovery: iso(120_000), is_stale: false, live: "LIVE", stale_message: null },
    summary: { free_models: rows.length, online_now: rows.length, best_tps: rows[0], best_ttft: rows[0], benchmarks_24h: 42 },
  };
}
function historyBody(ids) {
  const now = Date.now();
  const history = {};
  for (const id of ids) {
    const base = MODELS.find((m) => m.model_id === Number(id)) ?? MODELS[0];
    const idx = MODELS.indexOf(base);
    history[String(id)] = Array.from({ length: 12 }, (_, i) => ({
      hour_start: new Date(now - (11 - i) * HOUR).toISOString(),
      median_tps: 90 - idx * 7 + (i % 4),
      median_ttft: 220 + idx * 40 + (i % 3) * 10,
      median_itl: 13 + idx,
      success_rate: 1,
      uptime: 1,
    }));
  }
  return { history, meta: { granularity: "hourly" } };
}

function modelsBody() {
  return {
    models: MODELS.map((m) => ({
      id: m.model_id,
      provider_name: m.provider,
      provider_model_id: m.model,
      display_name: m.display_name,
      free_status: "FREE",
      active: 1,
      benchmark_enabled: 1,
      context_length: 131072,
      input_price: "0",
      output_price: "0",
    })),
    count: MODELS.length,
  };
}

function compareBody(ids) {
  return {
    compare: ids.map((rawId) => {
      const m = MODELS.find((x) => x.model_id === Number(rawId)) ?? MODELS[0];
      const i = MODELS.indexOf(m);
      return { display_name: m.display_name, provider: m.provider, tps_24h: 98 - i * 7, tps_7d: 97 - i * 7, ttft_24h: 200 + i * 40, ttft_7d: 220 + i * 40, uptime_7d: 0.99, error_rate: 0.01 };
    }),
    recommended_provider: "groq",
  };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json; charset=utf-8" };

function sendJson(res, body, status) {
  const payload = JSON.stringify(body);
  res.writeHead(status ?? 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function handleApi(pathname, url, req, res) {
  if (pathname === "/api/live") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    req.on("close", () => {});
    return;
  }
  if (pathname === "/api/leaderboard") return sendJson(res, leaderboardBody());
  if (pathname === "/api/providers") {
    return sendJson(res, { providers: [], registry: MODELS.map((m) => m.provider).filter((v, i, a) => a.indexOf(v) === i).map((name) => ({ name, freeTier: { notes: "mock tier" } })) });
  }
  if (pathname === "/api/models") return sendJson(res, modelsBody());
  if (pathname.indexOf("/api/models/") === 0) {
    const tail = pathname.slice("/api/models/".length);
    if (tail.indexOf("/history") > 0) return sendJson(res, { history: [] });
    const id = Number(tail);
    const m = MODELS.find((x) => x.model_id === id);
    if (m == null) return sendJson(res, { error: "not found" }, 404);
    return sendJson(res, { model: { id: m.model_id, provider_name: m.provider, provider_model_id: m.model, display_name: m.display_name, free_status: "FREE", active: 1, context_length: 131072, input_price: "0", output_price: "0" } });
  }
  if (pathname === "/api/history") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    return sendJson(res, historyBody(ids));
  }
  if (pathname === "/api/compare") {
    const ids = (url.searchParams.get("models") ?? "").split(",").filter(Boolean);
    return sendJson(res, compareBody(ids));
  }
  if (pathname === "/api/cooldowns") return sendJson(res, { providers: [], models: [], now: new Date().toISOString(), meta: { providerCooldowns: 0, modelCooldowns: 0 } });
  if (pathname === "/api/timeouts") return sendJson(res, { failures: [], providers: [], topModels: [], granularity: "daily", meta: { total_runs: 0, total_failures: 0, retention_note: "mock" } });
  return sendJson(res, { error: "not mocked" }, 404);
}

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  try {
    const file = await readFile(join(DIST, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(file);
    return;
  } catch {
    try {
      const index = await readFile(join(DIST, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(index);
      return;
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("dist missing");
    }
  }
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let page;
let baseUrl;
const consoleErrors = [];
const pageErrors = [];
const CSP_META_NOTICE = /frame-ancestors.*is ignored when delivered via/;
// Armed only around the deliberate model-404 navigation: Chromium logs the
// expected failed fetch as a console error even though the app handles the
// 404 into its not-found UI. Narrowly scoped so real 404s still fail the gate.
let allowOneResource404 = false;
const EXPECTED_API_404 = /Failed to load resource.*status of 404/;
const ignoredConsole = [];
const shot = (name) => page.screenshot({ path: join(SHOT_DIR, name + ".png") });

test("dashboard shows Rel 24h, thinking badge, intelligence link", async () => {
  await page.goto(baseUrl + "#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 15000 });
  const body = await page.locator("table").first().innerText();
  assert.match(body, /24h Rel/);
  assert.match(body, /95\.0%/);
  assert.match(body, /Thinking/);
  assert.match(body, /non-reasoning/);
  assert.match(body, /43\.6/);
  await shot("parity-dashboard");
});

test("six pins produce a shareable compare URL that restores", async () => {
  for (const i of [3, 4, 5]) {
    await page.locator("table tbody tr").nth(i).locator("td").first().click();
  }
  await page.waitForFunction(() => window.location.hash.indexOf("compare=") > 0, undefined, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.location.hash), "#/?compare=1,2,3,4,5,6");
  await page.locator("text=6/6 selected").first().waitFor({ timeout: 5000 });
  const url = baseUrl + "#/?compare=2,3";
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 15000 });
  await page.locator("text=2/6 selected").first().waitFor({ timeout: 5000 });
});

test("models catalog groups by provider with detail links", async () => {
  await page.goto(baseUrl + "#/models", { waitUntil: "domcontentloaded" });
  await page.locator("section header").first().waitFor({ timeout: 15000 });
  for (const p of ["groq", "ollama", "openrouter", "opencode_go", "opencode_zen"]) {
    assert.equal(await page.locator("section header", { hasText: p }).count(), 1, "group " + p);
  }
  const href = await page.locator("a", { hasText: "Open" }).first().getAttribute("href");
  assert.match(href ?? "", /#\/model\/\d+/);
  await shot("parity-models");
});

test("model detail shows stats, charts, intelligence; unknown stays 404", async () => {
  await page.goto(baseUrl + "#/model/1", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Kimi K3", { timeout: 15000 });
  const body = await page.locator("main, #root").first().innerText();
  assert.match(body, /43\.6/);
  assert.match(body, /Thinking/);
  await page.waitForSelector("svg", { timeout: 15000 });
  await shot("parity-detail");
  allowOneResource404 = true;
  await page.goto(baseUrl + "#/model/9999", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Model not found", { timeout: 15000 });
});

test("pricing and vs pages render", async () => {
  await page.goto(baseUrl + "#/pricing", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Benchmark cadence", { timeout: 15000 });
  assert.match(await page.locator("#root").first().innerText(), /free/);
  await shot("parity-pricing");
  await page.goto(baseUrl + "#/vs", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=ModelPulseX vs others", { timeout: 15000 });
  assert.match(await page.locator("#root").first().innerText(), /TokenDyno/);
  await shot("parity-vs");
});

test("theme toggle persists light mode", async () => {
  await page.goto(baseUrl + "#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), null);
  await page.locator("header button[title*=theme i]").click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "light");
  assert.equal(await page.evaluate(() => window.localStorage.getItem("mpx-theme")), "light");
  await shot("parity-light");
  await page.locator("header button[title*=theme i]").click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  await shot("parity-dark");
});

test("zero console and page errors throughout", async () => {
  assert.deepEqual(pageErrors, [], "page errors: " + pageErrors.join(" | "));
  assert.deepEqual(consoleErrors, [], "console errors: " + consoleErrors.join(" | "));
});

async function main() {
  try {
    await readFile(join(DIST, "index.html"));
  } catch {
    console.error("dist has no index.html — run `npm run build` first.");
    process.exit(1);
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return handleApi(url.pathname, url, req, res);
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    return void serveStatic(url.pathname, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  // 1600px wide so 2xl-only columns (Intelligence, Trend) render like TokenDyno's full table.
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text().slice(0, 300);
    if (CSP_META_NOTICE.test(text)) { ignoredConsole.push(text); return; }
    if (allowOneResource404 && EXPECTED_API_404.test(text)) { allowOneResource404 = false; ignoredConsole.push(text); return; }
    consoleErrors.push(text);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  console.log("e2e parity smoke — " + baseUrl + " (dist/frontend)");
  mkdirSync(SHOT_DIR, { recursive: true });
  const failures = [];
  for (const t of tests) {
    try { await t.fn(); console.log("  ok - " + t.name); }
    catch (e) {
      failures.push({ name: t.name, error: e });
      console.log("  FAIL - " + t.name + ": " + String(e).split("\n")[0]);
      try { await page.screenshot({ path: join(SHOT_DIR, "fail-" + t.name.replace(/[^a-z0-9]+/gi, "-") + ".png"), fullPage: true }); }
      catch { /* best-effort diagnostics only */ }
    }
  }
  await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  console.log(" " + (tests.length - failures.length) + " passed, " + failures.length + " failed");
  if (failures.length) { for (const f of failures) console.error("FAIL " + f.name + ": " + (f.error && f.error.stack ? f.error.stack : String(f.error))); process.exit(1); }
}

await main();
