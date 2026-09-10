import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Issue #23: `BENCHMARK_TIMEOUT_MS` was declared in wrangler.jsonc and Env and read
 *  by nothing, so operators tuned a 30s "global timeout" that did not exist while the
 *  shipped coding workload runs with `timeout_ms: 300_000`. These guards fail when a
 *  config key has no consumer — i.e. when config reads as a control but is dead. */

/** Source text that could consume a config value. `src/types.ts` is excluded: a
 *  declaration is not a consumer. */
function consumerSources(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name).replace(/\\/g, "/");
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk("src");
  return files
    .filter((f) => f !== "src/types.ts")
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

/** Keys of the `vars` block in wrangler.jsonc. Hand-scanned over the braced block so
 *  JSONC comments (and the binding sections above it) cannot confuse the extraction. */
function wranglerVarKeys(): string[] {
  const jsonc = readFileSync("wrangler.jsonc", "utf8");
  const start = jsonc.indexOf('"vars"');
  expect(start, 'wrangler.jsonc must contain a "vars" block').toBeGreaterThan(-1);
  const open = jsonc.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < jsonc.length; i++) {
    if (jsonc[i] === "{") depth++;
    else if (jsonc[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return [...jsonc.slice(open, end).matchAll(/"([A-Z][A-Z0-9_]*)"\s*:/g)].map(
    (m) => m[1]!,
  );
}

describe("config consumers (#23)", () => {
  it("every wrangler.jsonc var is read by at least one src/ file", () => {
    const blob = consumerSources();
    const dead = wranglerVarKeys().filter((k) => !blob.includes(k));
    expect(dead, "dead wrangler vars — wire them up or delete them").toEqual([]);
  });

  it("every declared Env key is read by at least one src/ file", () => {
    const types = readFileSync("src/types.ts", "utf8");
    const start = types.indexOf("export interface Env");
    const body = types.slice(start, types.indexOf("[key: string]", start));
    const declared = [...body.matchAll(/^\s+([A-Z][A-Z0-9_]*)\??:/gm)].map(
      (m) => m[1]!,
    );
    expect(declared.length, "Env key extraction found nothing").toBeGreaterThan(
      20,
    );
    const blob = consumerSources();
    const dead = declared.filter((k) => !blob.includes(k));
    expect(dead, "dead Env declarations — wire them up or delete them").toEqual(
      [],
    );
  });

  it("the workload owns its timeout — no global timeout var exists", () => {
    expect(readFileSync("wrangler.jsonc", "utf8")).not.toContain(
      "BENCHMARK_TIMEOUT_MS",
    );
    expect(readFileSync("src/types.ts", "utf8")).not.toContain(
      "BENCHMARK_TIMEOUT_MS",
    );
  });
});
