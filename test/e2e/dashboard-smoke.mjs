#!/usr/bin/env node
/**
 * E2E smoke gate for the built dashboard (issue #15).
 *
 * Runs the real `dist/frontend` bundle (produced by `npm run build`) in headless
 * Chromium against an in-process mock of the `/api` surface, so the gate needs
 * no Durable Object, no D1 and no network. It fails (non-zero exit) when:
 *   1. the dashboard stops loading (title/header missing, console or page errors),
 *   2. the leaderboard stops rendering rows,
 *   3. the freshness banner stops telling the truth about `meta.is_stale`,
 *   4. an SSE `benchmark.completed` broadcast stops triggering a leaderboard refetch.
 *
 * SSE wire format is the real one from `src/live/performance-do.ts`: the DO
 * broadcasts the *event name* `benchmark` whose data payload is
 * `{"type":"benchmark.completed", ...}`; `useLeaderboard` listens on `benchmark`.
 * The refetch is deliberately debounced 10s in the hook, so the SSE case waits.
 *
 * Usage: npm run test:e2e   (requires `npm run build` first)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DIST = join(ROOT, "dist", "frontend");
const FAILURE_DIR = join(ROOT, "dump", "e2e");

// ── fixture data ────────────────────────────────────────────────────────────
// Shapes mirror src/api/leaderboard.ts (leaderboard rows + meta + summary).
const MODELS = [
  {
    model_id: 1,
    model: "opencode/lingua-free",
    display_name: "Lingua Free",
    provider: "opencode_zen",
    tps_now: 75.5,
    tps_1h: 74.2,
    tps_24h: 71.9,
    tps_7d: 68.4,
    ttft_now: 210,
    ttft_7d: 231,
    itl_now: 14.2,
    itl_7d: 15.1,
    uptime_7d: 0.995,
    error_rate_7d: 0.005,
    overall_score: 88.2,
  },
  {
    model_id: 2,
    model: "openrouter/gemma-free",
    display_name: "Gemma Free",
    provider: "openrouter",
    tps_now: 52,
    tps_1h: 51.1,
    tps_24h: 49.8,
    tps_7d: 47.3,
    ttft_now: 320,
    ttft_7d: 341,
    itl_now: 19.4,
    itl_7d: 20.2,
    uptime_7d: 0.971,
    error_rate_7d: 0.029,
    overall_score: 74.6,
  },
  {
    model_id: 3,
    model: "groq/llama-free",
    display_name: "Llama Free",
    provider: "groq",
    tps_now: 31.2,
    tps_1h: 30.4,
    tps_24h: 29.9,
    tps_7d: 28.1,
    ttft_now: 480,
    ttft_7d: 502,
    itl_now: 26.7,
    itl_7d: 27.9,
    uptime_7d: 0.882,
    error_rate_7d: 0.118,
    overall_score: 61.4,
  },
];

const HOUR = 3600_000;

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function leaderboardRows() {
  return MODELS.map((m, i) => ({
    ...m,
    rank: i + 1,
    free_status: "FREE",
    active: true,
    status: "SUCCESS",
    last_test: iso(90_000),
    sampleCount24h: 12,
    // 24 hourly median-TPS points for the Sparkline column
    sparkline: Array.from({ length: 24 }, (_, h) => m.tps_7d + (h % 5) - 2),
  }));
}

function leaderboardBody(state) {
  const rows = leaderboardRows();
  const stale = state.mode === "stale";
  const lastBenchmark = stale ? iso(3 * HOUR) : iso(60_000);
  return {
    leaderboard: rows,
    range: "7d",
    benchmark: "coding",
    sort: "overall",
    profile: "balanced",
    meta: {
      last_benchmark: lastBenchmark,
      last_aggregate: iso(90_000),
      last_discovery: iso(120_000),
      is_stale: stale,
      live: stale ? null : "● LIVE Data updated 60s ago",
      stale_message: stale ? `STALE DATA Last measurement: ${lastBenchmark}` : null,
    },
    summary: {
      free_models: rows.length,
      online_now: rows.length,
      best_tps: rows[0],
      best_ttft: rows[0],
      benchmarks_24h: 42,
    },
  };
}

function historyBody(ids) {
  const now = Date.now();
  const history = {};
  for (const id of ids) {
    const base = MODELS.find((m) => m.model_id === Number(id)) ?? MODELS[0];
    history[String(id)] = Array.from({ length: 12 }, (_, i) => ({
      hour_start: new Date(now - (11 - i) * HOUR).toISOString().slice(0, 13) + ":00:00",
      median_tps: base.tps_7d + (i % 4),
      median_ttft: base.ttft_7d + (i % 3) * 10,
      median_itl: base.itl_7d,
      success_rate: base.uptime_7d,
      uptime: base.uptime_7d,
    }));
  }
  return { history, meta: { granularity: "hourly" } };
}

// ── mock server ─────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const state = { mode: "live", leaderboardHits: 0, sseClients: new Set() };

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleApi(pathname, url, req, res) {
  if (pathname === "/api/live") {
    // SSE: hold the connection open and let the test push a real DO-shaped frame.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    state.sseClients.add(res);
    req.on("close", () => state.sseClients.delete(res));
    return;
  }
  if (pathname === "/api/leaderboard") {
    state.leaderboardHits += 1;
    return sendJson(res, leaderboardBody(state));
  }
  if (pathname === "/api/providers") {
    return sendJson(res, {
      providers: [
        {
          name: "opencode_zen",
          freeTier: { rpm: 20, rpd: 200, notes: "free tier" },
          usage24h: 12,
        },
        { name: "openrouter", freeTier: { rpm: 20, rpd: 50 }, usage24h: 8 },
        { name: "groq", freeTier: { rpm: 30, rpd: 1000 }, usage24h: 4 },
      ],
    });
  }
  if (pathname === "/api/history") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    return sendJson(res, historyBody(ids));
  }
  if (pathname === "/api/cooldowns") {
    return sendJson(res, {
      providers: [],
      models: [],
      now: new Date().toISOString(),
      meta: { providerCooldowns: 0, modelCooldowns: 0 },
    });
  }
  if (pathname === "/api/timeouts") {
    return sendJson(res, {
      failures: [],
      providers: [],
      topModels: [],
      granularity: "daily",
      meta: { total_runs: 0, total_failures: 0, retention_note: "mock" },
    });
  }
  if (pathname === "/api/compare") {
    return sendJson(res, { compare: [], recommended_provider: null });
  }
  return sendJson(res, { error: "not mocked" }, 404);
}

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  try {
    const file = await readFile(join(DIST, rel));
    res.writeHead(200, {
      "content-type": MIME[extname(rel)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(file);
  } catch {
    // SPA fallback (mirrors wrangler assets not_found_handling: single-page-application)
    try {
      const index = await readFile(join(DIST, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(index);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("dist/frontend/index.html missing — run `npm run build` first");
    }
  }
}

function pushBenchmarkCompleted() {
  // Same frame the DO broadcasts: event name `benchmark`, payload type `benchmark.completed`.
  const frame =
    `event: benchmark\n` +
    `data: ${JSON.stringify({
      type: "benchmark.completed",
      model: "lingua-free",
      provider: "opencode_zen",
      tps: 75.5,
      ttft_ms: 210,
      status: "SUCCESS",
      benchmark_type: "coding",
      timestamp: new Date().toISOString(),
    })}\n\n`;
  for (const client of state.sseClients) client.write(frame);
  return state.sseClients.size;
}

async function waitFor(check, timeoutMs, label, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── harness ─────────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let page;
let baseUrl;
const consoleErrors = [];
const pageErrors = [];
// Chromium refuses `frame-ancestors` when it arrives via <meta> and logs an
// error on every load (frontend/index.html:12). Edge headers are the real
// clickjacking gate, so this specific notice is not a dashboard failure — it is
// allowlisted by exact message and reported in the summary.
const CSP_META_NOTICE =
  /Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element\./;
const ignoredConsole = [];

test("dashboard loads (title + header, no console/page errors)", async () => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=LLM PERFORMANCE OBSERVATORY", {
    timeout: 15_000,
  });
  await page.waitForSelector("table tbody tr", { timeout: 15_000 });
  assert.equal(await page.title(), "ModelPulseX — LLM Performance Observatory");
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(
    consoleErrors,
    [],
    `console errors: ${consoleErrors.join(" | ")}`,
  );
});

test("leaderboard renders one row per model", async () => {
  const rows = page.locator("table tbody tr");
  assert.equal(await rows.count(), MODELS.length);
  for (const m of MODELS)
    assert.equal(
      await page.locator("table tbody tr", { hasText: m.display_name }).count(),
      1,
      `row for ${m.display_name}`,
    );
  // TPS Now column value is the measured tps_now, not a placeholder
  const first = await rows.first().innerText();
  assert.match(first, /75\.5/);
});

test("freshness banner shows LIVE when meta.is_stale is false", async () => {
  const banner = page.locator('div[class*="bg-emerald-950/30"]');
  assert.equal(await banner.count(), 1, "live banner element");
  const text = await banner.innerText();
  assert.match(text, /LIVE/);
  assert.doesNotMatch(text, /STALE/);
  assert.equal(await page.locator('div[class*="bg-amber-950/40"]').count(), 0);
});

test("freshness banner shows STALE when meta.is_stale is true", async () => {
  state.mode = "stale";
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const banner = page.locator('div[class*="bg-amber-950/40"]');
  await banner.waitFor({ timeout: 15_000 });
  const text = await banner.innerText();
  assert.match(text, /STALE DATA/);
  assert.doesNotMatch(text, /● LIVE/);
  assert.equal(await page.locator('div[class*="bg-emerald-950/30"]').count(), 0);
  state.mode = "live";
});

test("SSE benchmark.completed broadcast triggers a leaderboard refetch", async () => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 15_000 });
  await waitFor(() => state.sseClients.size > 0, 15_000, "SSE client to connect");
  const before = state.leaderboardHits;
  assert.equal(pushBenchmarkCompleted(), 1, "one SSE subscriber received it");
  // useLeaderboard debounces SSE-triggered refetches by 10s on purpose.
  await waitFor(
    () => state.leaderboardHits > before,
    25_000,
    `leaderboard refetch after the SSE event (hits stayed ${before})`,
  );
  assert.ok(
    (await page.locator("table tbody tr").count()) === MODELS.length,
    "rows still rendered after the refetch",
  );
});

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    await readFile(join(DIST, "index.html"));
  } catch {
    console.error(
      `✗ ${DIST} has no index.html — run \`npm run build\` before \`npm run test:e2e\`.`,
    );
    process.exit(1);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/"))
      return handleApi(url.pathname, url, req, res);
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    return void serveStatic(url.pathname, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text().slice(0, 300);
    if (CSP_META_NOTICE.test(text)) ignoredConsole.push(text);
    else consoleErrors.push(text);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  console.log(`▶ e2e dashboard smoke — ${baseUrl} (dist/frontend)\n`);
  const failures = [];
  const started = Date.now();
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failures.push({ name: t.name, error: e });
      console.log(`  ✗ ${t.name}\n      ${String(e).split("\n")[0]}`);
      try {
        mkdirSync(FAILURE_DIR, { recursive: true });
        const shot = join(FAILURE_DIR, `${slug(t.name)}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`      screenshot: ${shot}`);
      } catch {
        /* screenshot is best-effort diagnostics only */
      }
    }
  }

  await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n  ${tests.length - failures.length} passed, ${failures.length} failed in ${secs}s`,
  );
  if (ignoredConsole.length)
    console.log(
      `  note: ignored ${ignoredConsole.length} browser CSP meta notice(s): ${ignoredConsole[0]}`,
    );
  if (failures.length) {
    for (const f of failures)
      console.error(`\n✗ ${f.name}\n${f.error?.stack ?? String(f.error)}`);
    process.exit(1);
  }
}

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

await main();
