#!/usr/bin/env node
/**
 * D1 query-plan guard (issue #12).
 *
 * The 2026-09-05/09 quota breach happened because the provider-count query planned as
 * `SCAN benchmark_runs USING INDEX idx_benchmark_runs_provider_model` — SQLite satisfied
 * `GROUP BY provider` from index order and never used `started_at >= ?` as an access path,
 * so a 60-second window paid for the whole 7-day table, 288 times a day.
 *
 * This guard runs `EXPLAIN QUERY PLAN` for every quota-critical query shape against a real
 * local D1 (same engine, same migrations) and fails when a shape stops using a range SEARCH
 * on an index. Full scans are allowed ONLY where listed in ACCEPTED_FULL_SCANS with a
 * reason — so reintroducing one anywhere else fails CI.
 *
 *   npm run test:plans
 */
import { execFileSync } from "node:child_process";

const ISO = "'2026-09-10T00:00:00.000Z'";

/** Every hot shape, with the SQL text kept byte-identical to the source that runs it. */
const CASES = [
  {
    name: "provider-usage count (src/db/cooldown.ts getProviderUsageSince)",
    // `GROUP BY +provider` is load-bearing: the unary + stops SQLite using index order
    // for the GROUP BY, which is what forces the started_at range access path.
    sql: `SELECT provider, COUNT(*) as cnt FROM benchmark_runs WHERE started_at >= ${ISO} GROUP BY +provider`,
    expect: /SEARCH benchmark_runs USING (COVERING )?INDEX idx_(runs_itl|benchmark_runs_started) \(started_at>\?\)/,
  },
  {
    name: "failure buckets (src/api/timeouts.ts, status != 'SUCCESS')",
    sql: `SELECT substr(started_at,1,10) AS bucket, provider, status, COUNT(*) AS n FROM benchmark_runs WHERE started_at >= ${ISO} AND status != 'SUCCESS' GROUP BY bucket, provider, status ORDER BY bucket ASC`,
    expect: /SEARCH benchmark_runs USING COVERING INDEX idx_runs_failures \(started_at>\?\)/,
  },
  {
    name: "top failing models (src/api/timeouts.ts, status != 'SUCCESS')",
    sql: `SELECT provider, model, COUNT(*) AS n FROM benchmark_runs WHERE started_at >= ${ISO} AND status != 'SUCCESS' GROUP BY provider, model ORDER BY n DESC LIMIT 10`,
    expect: /SEARCH benchmark_runs USING COVERING INDEX idx_runs_failures \(started_at>\?\)/,
  },
  {
    name: "provider totals, all statuses (src/api/timeouts.ts)",
    sql: `SELECT provider, SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) AS ok, COUNT(*) AS total FROM benchmark_runs WHERE started_at >= ${ISO} GROUP BY provider ORDER BY total DESC`,
    // ACCEPTED FULL SCAN — see below. Semantics require every status over the whole
    // window, so no index can serve it; the fix is pre-aggregation, not an index.
    accepted: "rows_read residual ~600k/day; needs pre-aggregation (issue #12 follow-up)",
  },
];

/**
 * Full scans that are accepted with a reason. Adding a new entry here is a deliberate,
 * reviewable act — that is the point of the guard. Each entry must name the reason and
 * the upgrade path.
 */
const ACCEPTED_FULL_SCANS = new Set([
  "provider totals, all statuses (src/api/timeouts.ts)",
]);

function wrangler(args) {
  // Invoke the local wrangler through node's own binary: `npx` is a .cmd shim on
  // Windows and does not resolve under execFileSync without a shell (and passing a
  // shell here would mean re-quoting EXPLAIN SQL). This also skips npx startup cost.
  return execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function planFor(sql) {
  const out = wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--json",
    "--command",
    `EXPLAIN QUERY PLAN ${sql}`,
  ]);
  let json;
  try {
    json = JSON.parse(out.slice(out.indexOf("[")));
  } catch (e) {
    throw new Error(
      `wrangler returned unparseable JSON: ${String(e).slice(0, 120)} — raw: ${out.slice(0, 400)}`,
    );
  }
  return (json[0]?.results ?? []).map((r) => r.detail);
}

function main() {
  // Local D1 must exist and carry the migrations (idempotent; offline-safe).
  try {
    wrangler(["d1", "migrations", "apply", "DB", "--local"]);
  } catch (e) {
    const text = String(e.stdout ?? "") + String(e.stderr ?? "");
    if (!/No migrations to apply/i.test(text)) {
      console.error(
        "✗ could not prepare local D1 (needs node_modules/wrangler)\n" +
          text.slice(0, 2000),
      );
      process.exit(1);
    }
  }

  const failures = [];
  for (const c of CASES) {
    let plan;
    try {
      plan = planFor(c.sql);
    } catch (e) {
      failures.push(`${c.name}: EXPLAIN failed — ${String(e.stderr ?? e.message).slice(0, 300)}`);
      continue;
    }
    const text = plan.join("\n");
    const scanned = /SCAN benchmark_runs\b/.test(text);
    if (c.expect) {
      if (!c.expect.test(text)) {
        failures.push(
          `${c.name}: plan no longer uses the expected range index.\n    plan:\n      ${plan.join("\n      ")}`,
        );
        continue;
      }
      console.log(`✓ ${c.name}`);
    } else if (scanned) {
      if (ACCEPTED_FULL_SCANS.has(c.name)) {
        console.log(`~ ${c.name} — accepted full scan: ${c.accepted}`);
      } else {
        failures.push(
          `${c.name}: full scan reintroduced and not in ACCEPTED_FULL_SCANS (issue #12).\n    plan:\n      ${plan.join("\n      ")}`,
        );
      }
    } else {
      console.log(`✓ ${c.name}`);
    }
  }

  if (failures.length) {
    console.error(`\n✗ D1 query-plan guard failed (${failures.length}):`);
    for (const f of failures) console.error("  - " + f);
    console.error(
      "\nFix the query (e.g. `GROUP BY +column` to defeat the index-order shortcut) or,\n" +
        "for a genuinely unavoidable scan, add it to ACCEPTED_FULL_SCANS with a reason.",
    );
    process.exit(1);
  }
  console.log("\n✓ all hot query shapes use a range access path");
}

main();
