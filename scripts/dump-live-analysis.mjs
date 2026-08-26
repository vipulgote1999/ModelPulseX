#!/usr/bin/env node
// Dump live Cloudflare D1 data for ModelPulseX and analyze working vs non-working models.
// Exports JSON dumps and a markdown analysis report.
// Usage: node scripts/dump-live-analysis.mjs
import { execSync, spawnSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";

const DB = "DB";
const DUMP_DIR = join(process.cwd(), "dump");
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = join(DUMP_DIR, `live-${TS}`);
mkdirSync(OUT_DIR, { recursive: true });

console.log(`→ Dump dir: ${OUT_DIR}`);

function execQuery(sql, label) {
  // Collapse to single line and escape double quotes so shell quoting stays simple.
  const single = sql.replace(/\s+/g, " ").trim().replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute ${DB} --remote --command "${single}" --json`;
  let stdout;
  try {
    stdout = execSync(cmd, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    console.error(`✗ ${label} exec failed`);
    const out = String(e.stdout ?? e.stderr ?? e.message ?? "").slice(0, 6000);
    console.error(out);
    throw e;
  }
  const idx = stdout.indexOf("[");
  if (idx === -1) {
    console.error(`✗ ${label} no JSON found`);
    console.error(stdout.slice(0, 6000));
    throw new Error(`no JSON for ${label}`);
  }
  const jsonStr = stdout.slice(idx);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error(`✗ ${label} JSON parse failed`, e);
    console.error(jsonStr.slice(0, 6000));
    throw e;
  }
  // Wrangler may return error object instead of array
  if (!Array.isArray(parsed)) {
    console.error(
      `✗ ${label} unexpected JSON`,
      JSON.stringify(parsed).slice(0, 2000),
    );
    throw new Error(`unexpected JSON for ${label}`);
  }
  // On error, parsed[0] has .error
  if (parsed[0]?.error) {
    console.error(
      `✗ ${label} wrangler error`,
      JSON.stringify(parsed[0].error).slice(0, 4000),
    );
    throw new Error(
      `wrangler error for ${label}: ${JSON.stringify(parsed[0].error)}`,
    );
  }
  const results = parsed[0]?.results ?? [];
  console.log(`  ✓ ${label}: ${results.length} rows`);
  return results;
}

function writeJson(name, data) {
  const path = join(OUT_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  console.log(
    `  ↳ wrote ${path} (${data.length} rows, ${(JSON.stringify(data).length / 1024).toFixed(1)}KB)`,
  );
}

function execAndDump(sql, name) {
  const rows = execQuery(sql, name);
  writeJson(name, rows);
  return rows;
}

// 1. providers
const providers = execAndDump(
  "SELECT * FROM providers ORDER BY name",
  "01-providers",
);

// 2. models joined
const models = execAndDump(
  `
SELECT m.id, m.provider_id, p.name as provider_name, m.provider_model_id, m.display_name, m.is_free, m.free_status, m.active, COALESCE(m.benchmark_enabled,1) as benchmark_enabled, m.context_length, m.first_seen, m.last_seen
FROM models m JOIN providers p ON p.id=m.provider_id
ORDER BY p.name, m.display_name
`,
  "02-models",
);

// 3. scheduler health
try {
  const health = execQuery(
    "SELECT * FROM scheduler_health ORDER BY id DESC LIMIT 20",
    "scheduler_health",
  );
  writeJson("03-scheduler_health", health);
} catch {
  console.warn("scheduler_health table maybe empty or missing");
}

// 4. cooldowns
try {
  const pc = execQuery(
    "SELECT * FROM provider_cooldowns ORDER BY cooldown_until DESC",
    "provider_cooldowns",
  );
  writeJson("04-provider_cooldowns", pc);
} catch (e) {
  console.warn("provider_cooldowns failed", e.message);
}
try {
  const mc = execQuery(
    "SELECT mc.model_id, p.name as provider_name, m.provider_model_id, m.display_name, mc.cooldown_until, mc.reason FROM model_cooldowns mc JOIN models m ON m.id=mc.model_id JOIN providers p ON p.id=m.provider_id ORDER BY mc.cooldown_until DESC LIMIT 500",
    "model_cooldowns",
  );
  writeJson("05-model_cooldowns", mc);
} catch (e) {
  console.warn("model_cooldowns failed", e.message);
}

// 5. benchmark_runs counts
const counts = execQuery(
  "SELECT count(*) as total_runs FROM benchmark_runs",
  "count",
);
console.log("total benchmark_runs:", counts[0]?.total_runs);

// 6. Aggregated per-model 7d stats
const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
void new Date(Date.now() - 3600 * 1000).toISOString(); // keep hour ref if needed

// per-model 7d aggregate
const agg7d = execAndDump(
  `
SELECT model_id, count(*) as total_7d, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as successes_7d, sum(CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END) as failures_7d,
  avg(CASE WHEN status='SUCCESS' THEN tps END) as avg_tps_success, avg(CASE WHEN status='SUCCESS' THEN ttft_ms END) as avg_ttft_success,
  min(started_at) as earliest_7d, max(started_at) as latest_7d
FROM benchmark_runs WHERE started_at >= '${sevenDaysAgo}' GROUP BY model_id
`,
  "06-agg-7d",
);

// per-model 24h
const agg24h = execAndDump(
  `
SELECT model_id, count(*) as total_24h, sum(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as successes_24h, sum(CASE WHEN status!='SUCCESS' THEN 1 ELSE 0 END) as failures_24h
FROM benchmark_runs WHERE started_at >= '${oneDayAgo}' GROUP BY model_id
`,
  "07-agg-24h",
);

// error breakdown per model (last 7d)
const errBreakdown = execAndDump(
  `
SELECT model_id, status, error_type, http_status, count(*) as cnt
FROM benchmark_runs WHERE started_at >= '${sevenDaysAgo}' GROUP BY model_id, status, error_type, http_status ORDER BY model_id, cnt DESC
`,
  "08-error-breakdown-7d",
);

// last run per model (use window function)
let lastRuns = [];
try {
  lastRuns = execAndDump(
    `
SELECT model_id, status as last_status, started_at as last_at, tps as last_tps, ttft_ms as last_ttft, error_type as last_error, http_status as last_http, provider as last_provider, model as last_model
FROM (
  SELECT model_id, status, started_at, tps, ttft_ms, error_type, http_status, provider, model, ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY started_at DESC) as rn FROM benchmark_runs
) WHERE rn=1
`,
    "09-last-run-per-model",
  );
} catch (e) {
  // fallback without window function: use max started_at join
  console.warn("window function failed, falling back", e.message);
  lastRuns = execAndDump(
    `
SELECT b.model_id, b.status as last_status, b.started_at as last_at, b.tps as last_tps, b.ttft_ms as last_ttft, b.error_type as last_error, b.http_status as last_http
FROM benchmark_runs b JOIN (SELECT model_id, max(started_at) as mx FROM benchmark_runs GROUP BY model_id) m ON m.model_id=b.model_id AND m.mx=b.started_at
`,
    "09-last-run-per-model",
  );
}

// provider-level summary
const providerSummary = execAndDump(
  `
SELECT p.name as provider, count(DISTINCT m.id) as models_total,
  sum(CASE WHEN COALESCE(m.benchmark_enabled,1)=1 AND m.active=1 AND m.free_status='FREE' THEN 1 ELSE 0 END) as enabled_free_active,
  count(DISTINCT CASE WHEN br.status='SUCCESS' THEN br.model_id END) as models_with_success_7d,
  count(DISTINCT CASE WHEN br.status!='SUCCESS' THEN br.model_id END) as models_with_failure_7d,
  count(br.id) as runs_7d, sum(CASE WHEN br.status='SUCCESS' THEN 1 ELSE 0 END) as successes_7d
FROM providers p
LEFT JOIN models m ON m.provider_id=p.id
LEFT JOIN benchmark_runs br ON br.model_id=m.id AND br.started_at >= '${sevenDaysAgo}'
GROUP BY p.name ORDER BY p.name
`,
  "10-provider-summary-7d",
);

// recent raw benchmark runs (last 300)
execAndDump(
  `
SELECT id, model_id, provider, model, benchmark_type, started_at, first_token_at, completed_at, tps, ttft_ms, status, error_type, http_status, token_estimation_method
FROM benchmark_runs ORDER BY started_at DESC LIMIT 300
`,
  "11-recent-300-runs",
);

// hourly stats count
const hourlyCount = execQuery(
  "SELECT count(*) as c FROM hourly_model_stats",
  "hourly count",
);
console.log("hourly stats total:", hourlyCount[0]?.c);
try {
  execAndDump(
    "SELECT * FROM hourly_model_stats ORDER BY hour_start DESC LIMIT 100",
    "12-hourly-sample-100",
  );
} catch {}

// incidents
try {
  execAndDump(
    "SELECT ai.*, p.name as provider_name, m.provider_model_id FROM availability_incidents ai JOIN models m ON m.id=ai.model_id JOIN providers p ON p.id=m.provider_id ORDER BY ai.started_at DESC LIMIT 200",
    "13-incidents-200",
  );
} catch (e) {
  console.warn("incidents failed", e.message);
}

// full export via wrangler d1 export
console.log("\n→ Attempting full SQL export via wrangler d1 export ...");
const exportPath = join(OUT_DIR, "full-export.sql");
const expRes = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "wrangler",
    "d1",
    "export",
    "modelpulsex-db",
    "--remote",
    "--output",
    exportPath,
  ],
  { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
if (expRes.status === 0) {
  console.log(`  ✓ full export wrote ${exportPath}`);
} else {
  console.warn("  ✗ full export failed (maybe auth or size)");
  console.warn(expRes.stderr?.slice(0, 1000));
}

// registry endpoints (hardcoded from source)
const PROVIDER_ENDPOINTS = {
  opencode_zen: {
    baseUrl: "https://opencode.ai/zen/v1",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    chatUrl: "https://opencode.ai/zen/v1/chat/completions",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    chatUrl: "https://api.groq.com/openai/v1/chat/completions",
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    modelsUrl: "https://api.cerebras.ai/v1/models",
    chatUrl: "https://api.cerebras.ai/v1/chat/completions",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    chatUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelsUrl: "https://integrate.api.nvidia.com/v1/models",
    chatUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  },
  sambanova: {
    baseUrl: "https://api.sambanova.ai/v1",
    modelsUrl: "https://api.sambanova.ai/v1/models",
    chatUrl: "https://api.sambanova.ai/v1/chat/completions",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    modelsUrl: "https://api.mistral.ai/v1/models",
    chatUrl: "https://api.mistral.ai/v1/chat/completions",
  },
  agnes_ai: {
    baseUrl: "https://apihub.agnes-ai.com/v1",
    modelsUrl: "https://apihub.agnes-ai.com/v1/models",
    chatUrl: "https://apihub.agnes-ai.com/v1/chat/completions",
  },
  aionlabs: {
    baseUrl: "https://api.aionlabs.ai/v1",
    modelsUrl: "https://api.aionlabs.ai/v1/models",
    chatUrl: "https://api.aionlabs.ai/v1/chat/completions",
  },
  kilocode: {
    baseUrl: "https://api.kilo.ai/api/gateway",
    modelsUrl: "https://api.kilo.ai/api/gateway/models",
    chatUrl: "https://api.kilo.ai/api/gateway/chat/completions",
  },
  glhf: {
    baseUrl: "https://glhf.chat/api/openai/v1",
    modelsUrl: "https://glhf.chat/api/openai/v1/models",
    chatUrl: "https://glhf.chat/api/openai/v1/chat/completions",
  },
  nscale: {
    baseUrl: "https://inference.api.nscale.com/v1",
    modelsUrl: "https://inference.api.nscale.com/v1/models",
    chatUrl: "https://inference.api.nscale.com/v1/chat/completions",
  },
  speka: {
    baseUrl: "https://speka.me/v1",
    modelsUrl: "https://speka.me/v1/models",
    chatUrl: "https://speka.me/v1/chat/completions",
  },
  nexaapi: {
    baseUrl: "https://api.nexa-api.com/v1",
    modelsUrl: "https://api.nexa-api.com/v1/models",
    chatUrl: "https://api.nexa-api.com/v1/chat/completions",
  },
  orcarouter: {
    baseUrl: "https://api.orcarouter.ai/v1",
    modelsUrl: "https://api.orcarouter.ai/v1/models",
    chatUrl: "https://api.orcarouter.ai/v1/chat/completions",
  },
  ninerouter: {
    baseUrl: "https://9router.com/v1",
    modelsUrl: "https://9router.com/v1/models",
    chatUrl: "https://9router.com/v1/chat/completions",
  },
  tokenrouter: {
    baseUrl: "https://api.tokenrouter.com/v1",
    modelsUrl: "https://api.tokenrouter.com/v1/models",
    chatUrl: "https://api.tokenrouter.com/v1/chat/completions",
  },
  ollama: {
    baseUrl: "https://ollama.com/v1",
    modelsUrl: "https://ollama.com/v1/models",
    chatUrl: "https://ollama.com/v1/chat/completions",
  },
};
writeJson(
  "00-provider-endpoints",
  Object.entries(PROVIDER_ENDPOINTS).map(([k, v]) => ({ name: k, ...v })),
);

// Build analysis
console.log("\n→ Building analysis report ...");
const agg7Map = new Map(agg7d.map((r) => [r.model_id, r]));
void new Map(agg24h.map((r) => [r.model_id, r])); // agg24 retained in dump for reference
const lastMap = new Map(lastRuns.map((r) => [r.model_id, r]));

// error breakdown per model grouped
const errMap = new Map();
for (const r of errBreakdown) {
  const arr = errMap.get(r.model_id) ?? [];
  arr.push(r);
  errMap.set(r.model_id, arr);
}

let working = 0,
  partially = 0,
  nonworking = 0,
  nodata = 0,
  disabled = 0,
  inactive = 0;
const perModelAnalysis = [];
for (const m of models) {
  const agg7 = agg7Map.get(m.id);
  const last = lastMap.get(m.id);
  const errs = errMap.get(m.id) ?? [];
  let bucket = "UNKNOWN";
  let detail = "";
  if (m.benchmark_enabled === 0) {
    bucket = "DISABLED";
    disabled++;
    detail = "benchmark_enabled=0";
  } else if (m.active === 0) {
    bucket = "INACTIVE";
    inactive++;
    detail = "active=0 (previously free)";
  } else if (!agg7) {
    bucket = "NO_DATA";
    nodata++;
    detail = "no runs in last 7d";
  } else if ((agg7.successes_7d ?? 0) === 0) {
    bucket = "NON_WORKING";
    nonworking++;
    detail = `0/${agg7.total_7d} successes last 7d`;
  } else if (
    last?.last_status === "SUCCESS" &&
    agg7.successes_7d / agg7.total_7d >= 0.5
  ) {
    bucket = "WORKING";
    working++;
    detail = `${agg7.successes_7d}/${agg7.total_7d} successes, last SUCCESS`;
  } else if ((agg7.successes_7d ?? 0) > 0 && last?.last_status !== "SUCCESS") {
    bucket = "PARTIALLY_WORKING";
    partially++;
    detail = `${agg7.successes_7d}/${agg7.total_7d} successes but last=${last?.last_status}`;
  } else if ((agg7.successes_7d ?? 0) > 0) {
    bucket = "PARTIALLY_WORKING";
    partially++;
    detail = `${agg7.successes_7d}/${agg7.total_7d} successes`;
  } else {
    bucket = "NON_WORKING";
    nonworking++;
  }

  perModelAnalysis.push({
    model_id: m.id,
    provider: m.provider_name,
    provider_model_id: m.provider_model_id,
    display_name: m.display_name,
    free_status: m.free_status,
    active: m.active,
    benchmark_enabled: m.benchmark_enabled,
    baseUrl: PROVIDER_ENDPOINTS[m.provider_name]?.baseUrl ?? null,
    chatUrl: PROVIDER_ENDPOINTS[m.provider_name]?.chatUrl ?? null,
    modelsUrl: PROVIDER_ENDPOINTS[m.provider_name]?.modelsUrl ?? null,
    total_7d: agg7?.total_7d ?? 0,
    successes_7d: agg7?.successes_7d ?? 0,
    failures_7d: agg7?.failures_7d ?? 0,
    success_rate_7d: agg7 ? agg7.successes_7d / agg7.total_7d : null,
    avg_tps_success: agg7?.avg_tps_success ?? null,
    avg_ttft_success: agg7?.avg_ttft_success ?? null,
    last_status: last?.last_status ?? null,
    last_at: last?.last_at ?? null,
    last_error: last?.last_error ?? null,
    last_http: last?.last_http ?? null,
    last_tps: last?.last_tps ?? null,
    last_ttft: last?.last_ttft ?? null,
    bucket,
    detail,
    error_breakdown: errs,
  });
}

perModelAnalysis.sort((a, b) => {
  const order = {
    WORKING: 0,
    PARTIALLY_WORKING: 1,
    NON_WORKING: 2,
    NO_DATA: 3,
    DISABLED: 4,
    INACTIVE: 5,
    UNKNOWN: 6,
  };
  return (
    (order[a.bucket] ?? 99) - (order[b.bucket] ?? 99) ||
    a.provider.localeCompare(b.provider) ||
    a.provider_model_id.localeCompare(b.provider_model_id)
  );
});

writeJson("99-per-model-analysis", perModelAnalysis);

// Provider rolled up
const providerRollup = {};
for (const pm of perModelAnalysis) {
  const p = (providerRollup[pm.provider] ??= {
    provider: pm.provider,
    baseUrl: pm.baseUrl,
    modelsUrl: pm.modelsUrl,
    chatUrl: pm.chatUrl,
    total: 0,
    WORKING: 0,
    PARTIALLY_WORKING: 0,
    NON_WORKING: 0,
    NO_DATA: 0,
    DISABLED: 0,
    INACTIVE: 0,
    avg_success_rate: null,
    runs_7d: 0,
    successes_7d: 0,
  });
  p.total++;
  p[pm.bucket] = (p[pm.bucket] ?? 0) + 1;
  p.runs_7d += pm.total_7d;
  p.successes_7d += pm.successes_7d;
}
for (const v of Object.values(providerRollup)) {
  v.avg_success_rate = v.runs_7d ? v.successes_7d / v.runs_7d : null;
}
writeJson(
  "98-provider-rollup",
  Object.values(providerRollup).sort((a, b) =>
    a.provider.localeCompare(b.provider),
  ),
);

// Markdown report
let md = `# ModelPulseX Live Analysis — ${new Date().toISOString()}\n\n`;
md += `Dumped from Cloudflare D1 \`modelpulsex-db\` (\`${TS}\`)\n\n`;
md += `**Counts:** providers=${providers.length}, models=${models.length}, benchmark_runs~${counts[0]?.total_runs ?? "?"}, hourly_stats sample dumped\n\n`;
md += `## Provider Endpoints (base URLs)\n\n`;
md += `| Provider | Base URL | Models URL | Chat URL |\n|---|---|---|---|\n`;
for (const [name, ep] of Object.entries(PROVIDER_ENDPOINTS).sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  md += `| ${name} | \`${ep.baseUrl}\` | \`${ep.modelsUrl}\` | \`${ep.chatUrl}\` |\n`;
}
md += `\n## Summary — Working vs Non-Working (last 7d window)\n\n`;
md += `Window: since \`${sevenDaysAgo}\` (last 7 days)\n\n`;
md += `| Bucket | Count | % |\n|---|---:|---:|\n`;
const tot = perModelAnalysis.length;
const buckets = [
  ["WORKING", working, "at least 1 success, last SUCCESS and ≥50% rate"],
  [
    "PARTIALLY_WORKING",
    partially,
    "some successes but last run failed or low rate",
  ],
  [
    "NON_WORKING",
    nonworking,
    "0 successes in last 7d (enabled & active but all failures)",
  ],
  [
    "NO_DATA",
    nodata,
    "no runs in last 7d (active+enabled but never queued / queued but no result yet)",
  ],
  ["DISABLED", disabled, "benchmark_enabled=0 — kept but not benchmarked"],
  [
    "INACTIVE",
    inactive,
    "active=0 (disappeared from discovery, PREVIOUSLY_FREE)",
  ],
];
for (const [b, c] of buckets) {
  md += `| **${b}** | ${c} | ${((c / tot) * 100).toFixed(1)}% |\n`;
}
md += `\n_Total models in dump: ${tot}_\n\n`;
for (const [b, c, _desc] of buckets) md += `- **${b}** (${c}): ${_desc}\n`;
md += `\n`;

md += `## Per-Provider Rollup (last 7d)\n\n`;
md += `| Provider | Base URL | Total Models | Enabled Free Active | WORKING | PARTIAL | NON_WORKING | NO_DATA | DISABLED | INACTIVE | Runs 7d | Succ 7d | Succ Rate |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const p of Object.values(providerRollup).sort(
  (a, b) => b.WORKING - a.WORKING,
)) {
  md += `| ${p.provider} | \`${p.baseUrl}\` | ${p.total} | ${providerSummary.find((x) => x.provider === p.provider)?.enabled_free_active ?? "?"} | ${p.WORKING} | ${p.PARTIALLY_WORKING} | ${p.NON_WORKING} | ${p.NO_DATA} | ${p.DISABLED} | ${p.INACTIVE} | ${p.runs_7d} | ${p.successes_7d} | ${p.avg_success_rate != null ? (p.avg_success_rate * 100).toFixed(1) + "%" : "—"} |\n`;
}
md += `\n`;

md += `## Working Models (detail)\n\n`;
md += `| Provider | Model | Free | TPS (avg succ) | TTFT | Succ/Total 7d | Last Status | Last At | Base URL |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const m of perModelAnalysis
  .filter((x) => x.bucket === "WORKING")
  .slice(0, 100)) {
  md += `| ${m.provider} | \`${m.provider_model_id.slice(0, 40)}\` | ${m.free_status} | ${m.avg_tps_success != null ? m.avg_tps_success.toFixed(1) : "—"} | ${m.avg_ttft_success != null ? Math.round(m.avg_ttft_success) : "—"} | ${m.successes_7d}/${m.total_7d} (${(m.success_rate_7d * 100).toFixed(0)}%) | ${m.last_status} | ${m.last_at ? new Date(m.last_at).toLocaleString() : "—"} | \`${m.baseUrl}\` |\n`;
}
if (perModelAnalysis.filter((x) => x.bucket === "WORKING").length > 100)
  md += `\n_... and ${perModelAnalysis.filter((x) => x.bucket === "WORKING").length - 100} more working models — see JSON_\n\n`;

md += `## Partially Working (flaky) — Top 50\n\n`;
md += `| Provider | Model | Succ/Total | Last Status | Last Error | Base URL |\n|---|---|---|---|---|---|\n`;
for (const m of perModelAnalysis
  .filter((x) => x.bucket === "PARTIALLY_WORKING")
  .slice(0, 50)) {
  md += `| ${m.provider} | \`${m.provider_model_id.slice(0, 40)}\` | ${m.successes_7d}/${m.total_7d} | ${m.last_status} | ${(m.last_error ?? "").slice(0, 60)} | \`${m.baseUrl}\` |\n`;
}
md += `\n`;

md += `## Non-Working (0 successes, enabled+active, last 7d) — Top 50\n\n`;
md += `| Provider | Model | Total 7d | Last Status | Last Error | HTTP | Base URL | Error Breakdown |\n|---|---|---|---|---|---|---|---|\n`;
for (const m of perModelAnalysis
  .filter((x) => x.bucket === "NON_WORKING")
  .slice(0, 50)) {
  const breakdown = m.error_breakdown
    .map((e) => `${e.status}:${e.error_type || "?"}(${e.cnt})`)
    .join(", ")
    .slice(0, 80);
  md += `| ${m.provider} | \`${m.provider_model_id.slice(0, 36)}\` | ${m.total_7d} | ${m.last_status} | ${(m.last_error ?? "").slice(0, 50)} | ${m.last_http ?? "—"} | \`${m.baseUrl}\` | ${breakdown} |\n`;
}
if (perModelAnalysis.filter((x) => x.bucket === "NON_WORKING").length > 50)
  md += `\n_... and ${perModelAnalysis.filter((x) => x.bucket === "NON_WORKING").length - 50} more — see JSON_\n\n`;

md += `## No Data (no runs 7d, but enabled+active)\n\n`;
md += `| Provider | Model | Free | Last Seen | Base URL |\n|---|---|---|---|---|\n`;
for (const m of perModelAnalysis
  .filter((x) => x.bucket === "NO_DATA")
  .slice(0, 50)) {
  md += `| ${m.provider} | \`${m.provider_model_id.slice(0, 40)}\` | ${m.free_status} | ${m.last_at ?? "never"} | \`${m.baseUrl}\` |\n`;
}
md += `\n`;

md += `## Disabled (benchmark_enabled=0) — kept but not benchmarked\n\n`;
md += `| Provider | Model | Free | Active | Last Seen |\n|---|---|---|---|---|\n`;
for (const m of perModelAnalysis
  .filter((x) => x.bucket === "DISABLED")
  .slice(0, 30)) {
  md += `| ${m.provider} | \`${m.provider_model_id.slice(0, 40)}\` | ${m.free_status} | ${m.active} | ${m.last_at ?? "—"} |\n`;
}
md += `\n`;

md += `## Recent Error Breakdown (by status, all providers, 7d)\n\n`;
const globalErr = {};
for (const r of errBreakdown) {
  const key = `${r.status} | ${r.error_type || "null"} | HTTP ${r.http_status ?? "—"}`;
  globalErr[key] = (globalErr[key] ?? 0) + r.cnt;
}
md += `| Status / Error | Count |\n|---|---:|\n`;
for (const [k, v] of Object.entries(globalErr).sort((a, b) => b[1] - a[1]))
  md += `| ${k} | ${v} |\n`;
md += `\n`;

md += `## Top Providers by Working Model Count\n\n`;
for (const p of Object.values(providerRollup)
  .sort((a, b) => b.WORKING - a.WORKING)
  .slice(0, 10)) {
  md += `- **${p.provider}** (\`${p.baseUrl}\`): ${p.WORKING} working / ${p.total} total, ${p.successes_7d}/${p.runs_7d} successes (${p.avg_success_rate != null ? (p.avg_success_rate * 100).toFixed(1) + "%" : "—"})\n`;
}
md += `\n`;

md += `## Files in this dump\n\n`;
md += `\`dump/live-${TS}/\` contains:\n`;
for (const f of [
  "00-provider-endpoints.json",
  "01-providers.json",
  "02-models.json",
  "06-agg-7d.json",
  "07-agg-24h.json",
  "08-error-breakdown-7d.json",
  "09-last-run-per-model.json",
  "10-provider-summary-7d.json",
  "11-recent-300-runs.json",
  "12-hourly-sample-100.json",
  "13-incidents-200.json",
  "98-provider-rollup.json",
  "99-per-model-analysis.json",
  "full-export.sql",
]) {
  md += `- \`${f}\`\n`;
}
md += `\n_Analysis generated: ${new Date().toISOString()} — window 7d since ${sevenDaysAgo}_\n`;
md += `_Next: investigate NON_WORKING by hitting their baseUrl/chatUrl directly with curl, check http_status + error_type, verify key/rate limits, and decide disable vs keep._\n`;

writeFileSync(join(OUT_DIR, "ANALYSIS.md"), md, "utf8");
console.log(`\n✓ wrote ${join(OUT_DIR, "ANALYSIS.md")}`);
console.log(`\nDump complete: ${OUT_DIR}`);
console.log(
  `Working: ${working}, Partially: ${partially}, Non-working: ${nonworking}, No data: ${nodata}, Disabled: ${disabled}, Inactive: ${inactive}`,
);
