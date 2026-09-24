#!/usr/bin/env node
/**
 * E2E smoke gate for the Admin > Playground tab (feat/admin-playground).
 *
 * Serves the real `dist/frontend` bundle in headless Chromium against an
 * in-process mock of the `/api` surface (no D1, no provider keys, no network).
 * Fails (non-zero exit) when:
 *   1. the admin login + Playground tab stop rendering,
 *   2. Run test does not render the mocked metrics + answer preview,
 *   3. the client leaks registry-only fields (apiUrl/apiKey/headers) in the
 *      playground request body,
 *   4. page/console errors appear.
 *
 * Usage: node test/e2e/playground-smoke.mjs  (requires `npm run build` first)
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

let lastPlaygroundBody = null;

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(data || "{}"));
      } catch {
        resolveBody({});
      }
    });
  });
}

async function handleApi(pathname, req, res) {
  if (pathname === "/api/leaderboard") {
    // Dashboard mounts briefly before the test navigates to Admin.
    return sendJson(res, {
      leaderboard: [],
      range: "7d",
      benchmark: "coding",
      meta: { is_stale: false, live: "mock" },
      summary: {},
    });
  }
  if (pathname === "/api/live") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    req.on("close", () => {});
    return;
  }
  if (pathname === "/api/cooldowns") {
    return sendJson(res, { providers: [], models: [], now: new Date().toISOString() });
  }
  if (pathname === "/api/timeouts") {
    return sendJson(res, { failures: [], providers: [], topModels: [] });
  }
  if (pathname === "/api/providers") {
    return sendJson(res, {
      providers: [],
      registry: [
        {
          name: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          modelsUrl: "https://openrouter.ai/api/v1/models",
          chatUrl: "https://openrouter.ai/api/v1/chat/completions",
        },
        {
          name: "opencode_zen",
          baseUrl: "https://opencode.ai/zen/v1",
          modelsUrl: "https://opencode.ai/zen/v1/models",
          chatUrl: "https://opencode.ai/zen/v1/chat/completions",
        },
      ],
    });
  }
  if (pathname === "/api/admin/login" && req.method === "POST") {
    await readBody(req);
    return sendJson(res, { ok: true, token: "e2e-admin-token" });
  }
  if (pathname === "/api/admin/models") {
    return sendJson(res, { models: [] });
  }
  if (pathname === "/api/admin/playground/test" && req.method === "POST") {
    lastPlaygroundBody = await readBody(req);
    return sendJson(res, {
      ok: true,
      provider: "openrouter",
      model: "test:free",
      resolvedChatUrl: "https://openrouter.ai/api/v1/chat/completions",
      free_status: "FREE",
      would_queue_in_cron: true,
      result: {
        status: "SUCCESS",
        http_status: 200,
        ttft_ms: 210,
        tps: 52.4,
        generation_ms: 1908,
        itl_ms: 19.4,
        chunk_count: 24,
        input_tokens: 12,
        output_tokens: 100,
        token_estimation_method: "provider",
        error_type: null,
      },
      preview: "PONG from the mock provider.",
    });
  }
  logUnmocked(pathname, req);
  return sendJson(res, { error: "not mocked" }, 404);
}

function logUnmocked(pathname, req) {
  if (process.env.E2E_VERBOSE) console.error(`  [mock] ${req.method} ${pathname} -> 404`);
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

// ── harness ─────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let page;
let baseUrl;
const consoleErrors = [];
const pageErrors = [];
const CSP_META_NOTICE =
  /Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element\./;

test("admin login + Playground tab render", async () => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Admin" }).click();
  await page.getByPlaceholder("admin").fill("admin");
  await page.getByPlaceholder("••••••••").fill("e2e");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("tab", { name: "Playground" }).click();
  await page.waitForSelector("#pg-provider", { timeout: 15_000 });
  assert.equal(await page.locator("#pg-prompt").count(), 1);
  assert.equal(await page.locator("#pg-model").count(), 1);
  // registry-only notice, no free-text URL field
  await page.waitForSelector("text=Custom base URLs are not allowed", {
    timeout: 15_000,
  });
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(
    consoleErrors,
    [],
    `console errors: ${consoleErrors.join(" | ")}`,
  );
});

test("preset switch fills prompt + max tokens", async () => {
  await page.selectOption("#pg-preset", "short-probe");
  assert.equal(await page.locator("#pg-prompt").inputValue(), "Say OK in 5 words.");
  assert.equal(await page.locator("#pg-maxtok").inputValue(), "32");
  await page.selectOption("#pg-preset", "coding-default");
});

test("run test renders metrics + preview, leaks no URL/key fields", async () => {
  await page.selectOption("#pg-provider", "openrouter");
  await page.locator("#pg-model").fill("test:free");
  await page.getByRole("button", { name: "Run test" }).click();
  await page.waitForSelector("text=PONG from the mock provider.", {
    timeout: 15_000,
  });
  const live = await page.locator('[aria-live="polite"]').innerText();
  assert.match(live, /SUCCESS/);
  assert.match(live, /52\.4/);
  assert.match(live, /210/);
  // registry-only: the request must carry names + prompt, never URLs or keys
  assert.ok(lastPlaygroundBody, "playground request reached the mock");
  assert.equal(lastPlaygroundBody.provider, "openrouter");
  assert.equal(lastPlaygroundBody.provider_model_id, "test:free");
  for (const banned of ["apiUrl", "baseUrl", "chatUrl", "apiKey", "extraHeaders", "headers"]) {
    assert.equal(
      lastPlaygroundBody[banned],
      undefined,
      `banned client field ${banned} must be absent`,
    );
  }
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(
    consoleErrors,
    [],
    `console errors: ${consoleErrors.join(" | ")}`,
  );
});

async function main() {
  try {
    await readFile(join(DIST, "index.html"));
  } catch {
    console.error(`✗ ${DIST} has no index.html — run \`npm run build\` first.`);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/"))
      return void handleApi(url.pathname, req, res);
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
    if (!CSP_META_NOTICE.test(text)) consoleErrors.push(text);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  console.log(`▶ e2e playground smoke — ${baseUrl} (dist/frontend)\n`);
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
        const shot = join(
          FAILURE_DIR,
          `${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
        );
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`      screenshot: ${shot}`);
      } catch {
        /* best-effort */
      }
    }
  }

  await context.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  ${tests.length - failures.length} passed, ${failures.length} failed in ${secs}s`);
  if (failures.length) {
    for (const f of failures)
      console.error(`\n✗ ${f.name}\n${f.error?.stack ?? String(f.error)}`);
    process.exit(1);
  }
}

await main();
