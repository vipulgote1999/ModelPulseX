#!/usr/bin/env node
// Seed mock 7-day benchmark data into local D1 for ModelPulseX demo/verification
// Usage: node scripts/seed-mock-data.mjs
// Requires wrangler dev not running — uses D1 local file via wrangler d1 execute

import { execSync } from "child_process";
import { randomInt } from "crypto";

function q(sql) {
  const cmd = `npx wrangler d1 execute DB --local --command "${sql.replace(/"/g, '\\"')}" --json 2>&1`;
  // Use execSync and capture
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  // Find JSON array in output
  const idx = out.indexOf("[");
  if (idx === -1) { console.error(out); return null; }
  const jsonStr = out.slice(idx);
  try { return JSON.parse(jsonStr); } catch { console.error("parse fail", jsonStr.slice(0,500)); return null; }
}

function execSql(sql) {
  const esc = sql.replace(/"/g, '\\"').replace(/\n/g, ' ');
  const cmd = `npx wrangler d1 execute DB --local --command "${esc}" 2>&1`;
  const out = execSync(cmd, { encoding: "utf8" });
  console.log(out.slice(-500));
}

// get models
let models;
try {
  const res = q("SELECT id, provider_model_id, display_name FROM models LIMIT 30");
  models = res?.[0]?.results ?? [];
} catch (e) { console.error(e); process.exit(1); }
if (!models || models.length === 0) {
  console.error("No models — run discovery first: curl -X POST http://127.0.0.1:8789/api/admin/discover -H 'Authorization: Bearer local-admin-token-change-me'");
  process.exit(1);
}
console.log(`Seeding ${models.length} models with 7 days of hourly benchmarks (3 benchmark_types)...`);

const now = Date.now();
const statuses = ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "TIMEOUT", "RATE_LIMITED", "PROVIDER_ERROR"];
const benchTypes = ["short", "medium", "coding"];

for (const m of models) {
  // For each model, create ~ 7*24/2 = 84 samples spread over 7 days (one per 2h per benchmark_type => ~84*3=252 per model worst)
  // To keep demo light, create ~ 40 per model
  const baseTps = 20 + Math.random() * 80; // 20-100
  const baseTtft = 200 + Math.random() * 1500;
  const reliability = 0.85 + Math.random() * 0.14;
  for (let i = 0; i < 42; i++) {
    const hoursAgo = Math.floor(Math.random() * 168); // 7d
    const started = new Date(now - hoursAgo * 3600 * 1000 - Math.random() * 3600 * 1000);
    const bench = benchTypes[i % 3];
    const isFail = Math.random() > reliability;
    const status = isFail ? statuses[randomInt(4, statuses.length)] : "SUCCESS";
    const first = new Date(started.getTime() + (isFail ? 0 : baseTtft + (Math.random() - 0.5) * 200));
    const completed = isFail ? null : new Date(first.getTime() + (100 + Math.random() * 2000));
    const outputTokens = isFail ? null : Math.floor(50 + Math.random() * 300);
    let tps = null, ttft = null, gen = null;
    if (!isFail && completed) {
      ttft = first.getTime() - started.getTime();
      gen = completed.getTime() - first.getTime();
      if (gen <= 0) gen = 1;
      tps = outputTokens / (gen / 1000);
      // jitter TPS around base
      tps = baseTps + (Math.random() - 0.5) * 10;
      ttft = baseTtft + (Math.random() - 0.5) * 200;
    }
    const provider = m.provider_model_id.includes(":") || m.provider_model_id.includes("/") ? "openrouter" : "opencode_zen";
    // crude provider detection: if id contains '/' or ':' => openrouter else zen; but many zen also not contain? Use display check: if id includes "free" and zen ids known, but openrouter ids have colon.
    // We'll just store provider from models table: need to fetch provider name
    // Instead query provider per model: join
    // Simpler: escape and insert directly
    const startedIso = started.toISOString();
    const firstIso = isFail ? "NULL" : `'${first.toISOString()}'`;
    const completedIso = isFail ? "NULL" : `'${completed.toISOString()}'`;
    const ttftVal = ttft == null ? "NULL" : ttft.toFixed(1);
    const genVal = gen == null ? "NULL" : gen.toFixed(1);
    const tpsVal = tps == null ? "NULL" : tps.toFixed(2);
    const httpStatus = status === "SUCCESS" ? 200 : status === "RATE_LIMITED" ? 429 : status === "TIMEOUT" ? 408 : 500;
    const sql = `INSERT INTO benchmark_runs (model_id, benchmark_type, started_at, first_token_at, completed_at, input_tokens, output_tokens, ttft_ms, generation_ms, tps, status, error_type, http_status, provider, model, token_estimation_method) VALUES (${m.id}, '${bench}', '${startedIso}', ${firstIso}, ${completedIso}, ${20 + Math.floor(Math.random()*40)}, ${outputTokens ?? "NULL"}, ${ttftVal}, ${genVal}, ${tpsVal}, '${status}', ${isFail ? `'${status} simulated'` : "NULL"}, ${httpStatus}, '${provider}', '${m.provider_model_id.replace(/'/g, "''")}', 'provider')`;
    execSql(sql);
  }
}
console.log("Seeding done. Now aggregating...");
// Aggregate per hour via node: call wrangler to run aggregation via JS? We'll use D1 to compute hourly aggregates via the same SQL logic as in queries.ts but simplified via direct SQL inserts.
// Instead just call the hourly aggregation via the admin endpoint if dev is running, or via wrangler d1 execute manual.
// For now, trigger aggregation via node that reuses queries logic by calling the Worker? Simpler: insert hourly aggregates directly via averaging.
// Let's run a Node script that queries benchmark_runs and computes aggregates into hourly_model_stats.

const aggSqls = `WITH hours AS (SELECT model_id, benchmark_type, strftime('%Y-%m-%dT%H:00:00.000Z', started_at) as hour_start, avg(tps) as avg_tps, avg(ttft_ms) as avg_ttft, count(*) as cnt FROM benchmark_runs GROUP BY model_id, benchmark_type, hour_start)
INSERT OR REPLACE INTO hourly_model_stats (model_id, hour_start, benchmark_type, avg_tps, median_tps, p90_tps, p95_tps, avg_ttft, median_ttft, p90_ttft, p95_ttft, success_rate, error_rate, uptime, request_count)
SELECT model_id, hour_start, benchmark_type, avg_tps, avg_tps, avg_tps, avg_tps, avg_ttft, avg_ttft, avg_ttft, avg_ttft, 0.9, 0.1, 0.9, cnt FROM hours`;
execSql(aggSqls);
console.log("Aggregates seeded (simplified). Run: npx wrangler d1 execute DB --local --command \"SELECT count(*) FROM hourly_model_stats\"");
