# ModelPulseX v2 Features Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship four backlog items in one release — split the 1,317-line API monolith into per-resource route factories, add an inter-token latency (ITL) metric end-to-end, surface provider free-tier rate limits, and add public API docs plus OG share cards.

**Architecture:** All four features touch `src/api/routes.ts`, so the route split goes first and converts later edits from "edit a 1,300-line file" to "edit one focused file". ITL follows (migration → engine capture → aggregates → API → chart), then free-tier limits (registry descriptor → API → badge), then docs + OG cards (OpenAPI endpoint → Docs page → dependency-free PNG encoder).

**Tech Stack:** TypeScript (strict), Cloudflare Workers + D1 + Queues + Cron + Durable Objects, Hono, React 18 + Vite + Tailwind + Recharts, Vitest, ESLint flat config.

---

## Baseline (verified 2026-08-30)

- `npm test` → **52/52 passing** (8 files)
- `npm run typecheck` → **clean**
- `npm run lint` → **clean**
- `node_modules` was absent; installed with `npm install --legacy-peer-deps` (318 packages)

**Never proceed on a red gate.** Every task below ends with the full preflight re-run. If a gate is red, stop and fix before starting the next task.

---

## Design System (UI work — Tasks 2, 3, 4)

The `ui-ux-pro-max` design-system search recommends a light `#F8FAFC` background. **Do not use it.** ModelPulseX already ships a dark theme; the skill's own `consistency` rule ("use same style across all pages") overrides the generated palette. Extend what exists:

| Token | Value | Source |
|---|---|---|
| Page background | `#0a0a0f` | `frontend/src/index.css:11` |
| Body text | `#e8e8ef` | `frontend/src/index.css:11` |
| Panel / card | `rounded-xl border border-zinc-800 bg-zinc-900/40 p-3` | all 4 charts, `Leaderboard.tsx:66` |
| KPI card | `rounded-xl border border-zinc-800 bg-zinc-900/60 p-3` | `SummaryCards.tsx:30` |
| Metric numerals | `.mono` (JetBrains Mono) + `text-right` | `index.css:12`, every table cell |
| Micro label | `text-[11px] tracking-widest text-zinc-500` | thead, KPI labels |
| Chart grid | `stroke="#27272a" strokeDasharray="3 3"` | `TpsChart.tsx:34` |
| Chart axis tick | `{ fontSize: 11, fill: "#a1a1aa" }` | all charts |
| Chart palette | `["#8b5cf6","#06b6d4","#f59e0b","#10b981","#ef4444","#e879f9"]` | `TpsChart.tsx:3`, `TtftChart.tsx:2` |
| Semantic badges | success→emerald, rate-limit/warn→amber, model→sky, brand→violet, neutral→zinc | `Leaderboard.tsx:116-117` |

**New ITL chart colour:** use `#06b6d4` (cyan) — the next unused palette entry after violet (TPS) and amber (TTFT), so the three latency charts stay visually distinct.

**Mandatory checklist for every UI change:**
- [ ] No emoji as icons — SVG or text only
- [ ] `cursor-pointer` on every clickable element
- [ ] Hover feedback with `transition-colors duration-200`
- [ ] Visible focus ring on interactive elements
- [ ] `prefers-reduced-motion` respected (no new unbounded animations)
- [ ] Responsive at 375 / 768 / 1024 / 1440px
- [ ] Contrast ≥ 4.5:1 — never `text-zinc-600` for body copy

---

## Task 1: Split `src/api/routes.ts` into per-resource route factories

**Why first:** it is a pure refactor with no behaviour change, and it turns every later task's edit into a small-file edit instead of a 1,317-line-file edit.

**Files:**
- Modify: `src/api/routes.ts` (1,317 lines → ~60 lines: CORS + mounts)
- Create: `src/api/shared.ts`, `src/api/health.ts`, `src/api/providers.ts`, `src/api/models.ts`, `src/api/leaderboard.ts`, `src/api/history.ts`, `src/api/compare.ts`, `src/api/cooldowns.ts`, `src/api/live.ts`, `src/api/admin/index.ts`, `src/api/admin/models.ts`, `src/api/admin/maintenance.ts`
- Test: `test/routes-parity.test.ts` (new)

**Route inventory (22 routes — the regression contract):**

```
GET  /api/health
GET  /api/providers
GET  /api/models
GET  /api/leaderboard
GET  /api/history
GET  /api/models/:id
GET  /api/models/:id/history
GET  /api/models/:id/incidents
GET  /api/compare
GET  /api/cooldowns
POST /api/admin/login
GET  /api/admin/models
POST /api/admin/models/:id/toggle
POST /api/admin/models/bulk
POST /api/admin/discover
POST /api/admin/benchmark
POST /api/admin/reaggregate
POST /api/admin/cleanup
POST /api/admin/cooldown/reset
POST /api/admin/migrate
POST /api/admin/fix-tps
GET  /api/live
```

### Step 1: Write the failing parity test

Create `test/routes-parity.test.ts`. Hono exposes `app.routes` as `[{ path, method, handler }]`; after `app.route("/api", sub)` the entries carry the full mounted path.

```ts
import { describe, it, expect } from "vitest";
import { createApi } from "../src/api/routes";

const EXPECTED = [
  "GET /api/health",
  "GET /api/providers",
  "GET /api/models",
  "GET /api/leaderboard",
  "GET /api/history",
  "GET /api/models/:id",
  "GET /api/models/:id/history",
  "GET /api/models/:id/incidents",
  "GET /api/compare",
  "GET /api/cooldowns",
  "POST /api/admin/login",
  "GET /api/admin/models",
  "POST /api/admin/models/:id/toggle",
  "POST /api/admin/models/bulk",
  "POST /api/admin/discover",
  "POST /api/admin/benchmark",
  "POST /api/admin/reaggregate",
  "POST /api/admin/cleanup",
  "POST /api/admin/cooldown/reset",
  "POST /api/admin/migrate",
  "POST /api/admin/fix-tps",
  "GET /api/live",
];

describe("api route parity", () => {
  it("mounts exactly the expected public surface", () => {
    // Env is only read lazily inside handlers; a stub is enough to build the app.
    const app = createApi({ CORS_ORIGIN: "https://example.test" } as never);
    const actual = (app as unknown as { routes: Array<{ path: string; method: string }> })
      .routes.filter((r) => r.method === "GET" || r.method === "POST")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(actual).toEqual([...EXPECTED].sort());
  });
});
```

### Step 2: Run the test to verify it passes as a baseline

Run: `npx vitest run test/routes-parity.test.ts`
Expected: **PASS** — this test locks in current behaviour *before* the refactor so any route lost during the split fails loudly.

### Step 3: Create `src/api/shared.ts`

Move the module-private helpers both admin and public routes need:

- `isAdmin(c, env)` from `routes.ts:1308-1317`
- `isoHoursAgo(h)` from `routes.ts:22-23` (with its comment — the comment explains a real production bug and must be preserved verbatim)

Export both. `parseRange` is already exported from `../db/queries` — do not duplicate it.

### Step 4: Extract each route group

For each group, create the file and export a factory. Pattern (health as the template):

```ts
import { Hono } from "hono";
import type { Env } from "../types";

export function healthRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/health", async (c) => {
    /* body moved verbatim */
  });
  return r;
}
```

Mapping of route → file (paths inside each factory are relative to `/api`):

| Route(s) | Destination file |
|---|---|
| `/api/health` | `src/api/health.ts` |
| `/api/providers` | `src/api/providers.ts` |
| `/api/models`, `/api/models/:id`, `/api/models/:id/history`, `/api/models/:id/incidents` | `src/api/models.ts` |
| `/api/leaderboard` | `src/api/leaderboard.ts` |
| `/api/history` | `src/api/history.ts` |
| `/api/compare` | `src/api/compare.ts` |
| `/api/cooldowns` | `src/api/cooldowns.ts` |
| `/api/live` | `src/api/live.ts` |
| `/api/admin/login`, `/api/admin/discover`, `/api/admin/benchmark` | `src/api/admin/index.ts` |
| `/api/admin/models`, `/api/admin/models/:id/toggle`, `/api/admin/models/bulk` | `src/api/admin/models.ts` |
| `/api/admin/reaggregate`, `/api/admin/cleanup`, `/api/admin/cooldown/reset`, `/api/admin/migrate`, `/api/admin/fix-tps` | `src/api/admin/maintenance.ts` |

**Rules for the move:**
- Copy handler bodies **verbatim**. This is a move, not a rewrite — no logic changes, no formatting changes, no "improvements".
- Each factory takes `env: Env` and closes over it, exactly as `createApi(env)` does today. Do **not** switch to `c.env` (that is a separate change with typing risk).
- Move each route's own imports with it. Delete imports from `routes.ts` that become unused (ESLint `no-unused-vars` will catch stragglers).
- The leaderboard handler is ~500 lines (routes.ts:134-632) and stays a single file. Splitting its internals is **explicitly out of scope** for this task.

### Step 5: Rewrite `src/api/routes.ts` as the mount point

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { healthRoutes } from "./health";
// ...one import per factory

export function createApi(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  const allowedOrigins = (env.CORS_ORIGIN ?? "https://modelpulsex.vipulgote5.workers.dev")
    .split(",").map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin: allowedOrigins,
    allowHeaders: ["content-type", "authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }));

  app.route("/api", healthRoutes(env));
  app.route("/api", providersRoutes(env));
  // ...one mount per factory
  return app;
}
```

CORS stays on the parent `app` — Hono runs parent middleware for `app.route`-mounted handlers.

### Step 6: Run preflight

Run: `npm test && npm run typecheck && npm run lint`
Expected: 52/52 tests (now 53 with the parity test), tsc clean, eslint clean.

If the parity test fails, a path was mistyped during the move — diff the reported set against `EXPECTED` and fix the mount/route path.

### Step 7: Commit

```bash
git add src/api test/routes-parity.test.ts
git commit -m "refactor(api): split routes.ts monolith into per-resource route factories"
```

---

## Task 2: Inter-token latency (ITL) metric, end to end

**Goal:** capture the gap between consecutive streamed chunks so the dashboard can distinguish smooth streaming from choppy streaming that identical TPS hides.

**Definition:** ITL = median of the deltas between consecutive content-bearing chunk arrival times. Requires ≥2 chunks.

**Files:**
- Create: `migrations/0009_itl.sql`
- Modify: `src/types.ts:85-103` (`BenchmarkResult`), `src/types.ts:139-170` (`LeaderboardRow`)
- Modify: `src/utils/metrics.ts` (add `computeInterTokenLatency`)
- Modify: `src/benchmark/engine.ts` (SSE loop + `finalize`)
- Modify: `src/db/queries.ts` (`insertBenchmarkRun` :327, `computeHourlyAggregates` :402, `computeTenminAggregates` :494)
- Modify: `src/api/leaderboard.ts`, `src/api/history.ts` (new files from Task 1)
- Modify: `frontend/src/hooks/useHistory.ts:3` (`Point`)
- Create: `frontend/src/charts/ItlChart.tsx`
- Modify: `frontend/src/pages/Dashboard.tsx`, `frontend/src/components/Leaderboard.tsx`
- Test: `test/metrics.test.ts`, `test/benchmark.test.ts`

### Step 1: Write the failing metric test

Append to `test/metrics.test.ts`:

```ts
import { computeInterTokenLatency } from "../src/utils/metrics";

describe("computeInterTokenLatency", () => {
  it("returns null with fewer than two chunks", () => {
    expect(computeInterTokenLatency([])).toBeNull();
    expect(computeInterTokenLatency([100])).toBeNull();
  });

  it("returns the gap for a single pair", () => {
    expect(computeInterTokenLatency([100, 150])).toBe(50);
  });

  it("uses the median so one stall does not dominate", () => {
    // gaps: 10, 10, 10, 500 -> median 10, mean 132.5
    expect(computeInterTokenLatency([0, 10, 20, 30, 530])).toBe(10);
  });

  it("ignores non-monotonic and nullish input", () => {
    expect(computeInterTokenLatency([50, 10])).toBeNull();
  });
});
```

### Step 2: Run it to verify it fails

Run: `npx vitest run test/metrics.test.ts`
Expected: **FAIL** — `computeInterTokenLatency` is not exported.

### Step 3: Implement the pure metric

In `src/utils/metrics.ts`:

```ts
/** Median gap between consecutive streamed chunks (ms). Measures streaming smoothness
 *  that identical TPS hides: 40 TPS delivered in bursts feels much worse than 40 TPS
 *  delivered evenly. Null until at least two chunks are observed. */
export function computeInterTokenLatency(chunkTimesMs: number[]): number | null {
  if (chunkTimesMs.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < chunkTimesMs.length; i++) {
    const gap = chunkTimesMs[i]! - chunkTimesMs[i - 1]!;
    if (gap < 0) return null; // non-monotonic clock — refuse to guess
    gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  return percentile(gaps, 50);
}
```

Reuse the existing `percentile` (line 26). Do not add a second percentile implementation — three already exist and the repo does not need a fourth.

### Step 4: Run the metric test

Run: `npx vitest run test/metrics.test.ts`
Expected: **PASS**

### Step 5: Write the failing engine test

Append to `test/benchmark.test.ts`, following the existing mocked-fetch pattern. Assert that a stream of four content chunks spaced 10ms apart yields `itl_ms === 10` and `chunk_count === 4`, and that a non-SUCCESS run yields `itl_ms === null`.

### Step 6: Run it to verify it fails

Run: `npx vitest run test/benchmark.test.ts`
Expected: **FAIL** — `itl_ms` / `chunk_count` do not exist on `BenchmarkResult`.

### Step 7: Capture chunk timestamps in the engine

In `src/benchmark/engine.ts`:

1. Declare alongside the other accumulators (~line 99): `const chunkTimes: number[] = [];`
2. Inside the SSE parse loop, right after the existing `if (delta && firstTokenAtMs == null) {...}` block (lines 238-244), record every content-bearing chunk:

```ts
if (typeof delta === "string" && delta.length > 0) {
  if (chunkTimes.length < MAX_CHUNK_SAMPLES) {
    chunkTimes.push(
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now(),
    );
  }
}
```

3. Add a module constant to bound memory on very long generations:

```ts
/** Cap retained chunk timestamps — a median over 512 gaps is statistically
 *  indistinguishable from the full stream, and raw runs must stay small. */
const MAX_CHUNK_SAMPLES = 512;
```

4. Extend `finalize()` with a `chunkTimesMs?: number[]` parameter and set:

```ts
const itlRaw = computeInterTokenLatency(chunkTimesMs ?? []);
const itl_ms = status === "SUCCESS" ? itlRaw : null;
const chunk_count = status === "SUCCESS" && chunkTimesMs != null && chunkTimesMs.length > 0
  ? chunkTimesMs.length
  : null;
```

Return both in the `BenchmarkResult` object.

### Step 8: Add the fields to `BenchmarkResult`

In `src/types.ts` (after `tps`, line 93):

```ts
/** Median gap between consecutive streamed chunks (ms); null unless SUCCESS with >=2 chunks. */
itl_ms: number | null;
/** Number of content-bearing chunks observed (bounded by MAX_CHUNK_SAMPLES). */
chunk_count: number | null;
```

### Step 9: Run the engine test

Run: `npx vitest run test/benchmark.test.ts`
Expected: **PASS**

### Step 10: Write migration `0009_itl.sql`

D1 does **not** support `IF NOT EXISTS` on `ADD COLUMN`, so every read of the new columns must be try/catch-guarded (existing precedent: `src/api/history.ts` tenmin fallback, `src/db/queries.ts:602-609`).

```sql
-- 0009_itl.sql — inter-token latency (streaming smoothness) metric
-- benchmark_runs: per-run median chunk gap + observed chunk count.
-- Aggregates: median/p90 ITL per bucket, mirroring the tps/ttft percentile columns.

ALTER TABLE benchmark_runs ADD COLUMN itl_ms REAL;
ALTER TABLE benchmark_runs ADD COLUMN chunk_count INTEGER;

ALTER TABLE hourly_model_stats ADD COLUMN median_itl REAL;
ALTER TABLE hourly_model_stats ADD COLUMN p90_itl REAL;

ALTER TABLE tenmin_model_stats ADD COLUMN median_itl REAL;
ALTER TABLE tenmin_model_stats ADD COLUMN p90_itl REAL;

CREATE INDEX IF NOT EXISTS idx_runs_itl ON benchmark_runs(started_at, itl_ms);
```

### Step 11: Persist ITL in `insertBenchmarkRun`

In `src/db/queries.ts:334`, add `itl_ms, chunk_count` to the column list (18 columns / 18 placeholders) and bind `r.itl_ms`, `r.chunk_count` in matching position.

### Step 12: Aggregate ITL

In both `computeHourlyAggregates` (:402) and `computeTenminAggregates` (:494):

1. Add `GROUP_CONCAT(itl_ms) as itls` to the SELECT (alongside `tpss` / `ttfts`).
2. Parse with the same inline filter used for tps/ttft, then `median_itl = percentile(itls, 50)`, `p90_itl = percentile(itls, 90)`.
3. Add `median_itl, p90_itl` to the `INSERT OR REPLACE` column list and binds (17 columns).

Guard the whole aggregate with try/catch: if the query throws with "no such column: itl_ms", re-run the original 3-concat query and bind `null` for both ITL columns. This keeps pre-migration databases working.

### Step 13: Expose ITL in the leaderboard

In `src/api/leaderboard.ts` (from Task 1):
- Add `AVG(CASE WHEN hour_start >= ? THEN median_itl END) as itl_7d` to `hourlySql` (was `routes.ts:257`) **and** the matching `?` bind in `hourlyBinds` in the same positional slot.
- Add `GROUP_CONCAT(CASE WHEN started_at >= ? THEN itl_ms END) as gc_itl_7d` to `rawWindowSql` plus its bind.
- Add fields to the local `HourlyRow` and `RawRow` interfaces **and to the `H0` zero-row default object** — `H0` must list every `HourlyRow` key or tsc fails.
- Map into the response via the existing `gatedMedian` helper so the `MIN_SAMPLES` gate (2/3/5) applies to ITL exactly as it does to TPS.

Add to `LeaderboardRow` in `src/types.ts`: `itl_now: number | null; itl_7d: number | null;`

### Step 14: Expose ITL in `/api/history`

In `src/api/history.ts`, add `median_itl` to all four SELECT variants (tenmin-all, tenmin-filtered, hourly-all, hourly-filtered), to the tenmin fallback SQL, and to the raw `benchmark_runs` fallback (`itl_ms as median_itl`).

### Step 15: Build the ITL chart

Create `frontend/src/charts/ItlChart.tsx` as a close clone of `TtftChart.tsx`:
- Default export, inline props type `{ series: Array<{ id: number; label: string; points: Array<{ hour_start: string; median_itl: number | null }> }>; range?: string }`
- Copy the local `COLORS` constant, the pivot-by-`hour_start` logic, `h-[260px]` height, `CartesianGrid stroke="#27272a"`, YAxis label `"ITL ms"`
- Chart line colour: `#06b6d4` (see Design System above)

### Step 16: Wire the chart and column into the UI

- `frontend/src/hooks/useHistory.ts:3` — add `median_itl: number | null` to `Point`
- `frontend/src/pages/Dashboard.tsx` — add `const ItlChart = lazy(() => import("../charts/ItlChart"));` alongside the existing lazy chart imports (:12-15) and render inside the same `<Suspense fallback={<ChartFallback />}>` block (:178-187)
- `frontend/src/components/Leaderboard.tsx`:
  - Add `itl_now: number | null; itl_7d: number | null` to the local `Row` type (:7-28)
  - Add a sortable `ITL` `<th>`/`<td>` pair next to `TTFT`, rendering `fmtMs(r.itl_now ?? r.itl_7d)`
  - **Add `itl_now` to the lower-is-better ternary at line 43** (`k === "ttft_now" || k === "ttft_7d"`) or the new column will sort descending-first
  - Fix the stale `colSpan={12}` on the empty row (:89) to match the new column count

### Step 17: Run preflight

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green. Pay attention to the `as unknown as Array<{...}>` inline row casts repeated at `Dashboard.tsx:122,167,173,176` — each must be widened for the new fields.

### Step 18: Apply the migration and smoke-test

```bash
npm run migrate:local
```

Then run `npm run dev` and confirm `/api/leaderboard` returns `itl_7d` and `/api/history?ids=1&range=24h` returns `median_itl`. Values will be `null` until fresh runs accumulate chunk data — that is expected, not a bug.

### Step 19: Commit

```bash
git add migrations/0009_itl.sql src frontend/src test
git commit -m "feat(itl): add inter-token latency metric end to end"
```

> **Non-goal:** ITL is intentionally **not** added to `overallScore` (`src/utils/metrics.ts:72`) in this task. Changing weights silently reorders the entire leaderboard; that needs its own decision and its own test.

---

## Task 3: Provider free-tier RPM/RPD awareness

**Goal:** answer "is this the fastest free model *and* can I actually use it all day?" by showing each provider's documented free-tier limits next to results.

**Files:**
- Modify: `src/providers/registry.ts:38-51` (`ProviderDescriptor`)
- Modify: `src/api/providers.ts` (new file from Task 1)
- Modify: `src/db/cooldown.ts` (add daily usage query beside `getProviderRPMUsage` :111)
- Modify: `frontend/src/components/Leaderboard.tsx`, `frontend/src/pages/Dashboard.tsx`
- Test: `test/provider-limits.test.ts` (new)

### Step 1: Write the failing test

Create `test/provider-limits.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PROVIDER_REGISTRY, freeTierFor } from "../src/providers/registry";

describe("provider free tier descriptors", () => {
  it("exposes a documented free tier for every registered provider", () => {
    for (const d of PROVIDER_REGISTRY) {
      expect(d.freeTier, `missing freeTier for ${d.name}`).toBeDefined();
    }
  });

  it("never reports a negative or zero limit", () => {
    for (const d of PROVIDER_REGISTRY) {
      const t = d.freeTier;
      if (!t) continue;
      for (const k of ["rpm", "rpd", "tokensPerDay"] as const) {
        const v = t[k];
        if (v != null) expect(v, `${d.name}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it("resolves unknown providers to null", () => {
    expect(freeTierFor("does_not_exist")).toBeNull();
  });
});
```

### Step 2: Run it to verify it fails

Run: `npx vitest run test/provider-limits.test.ts`
Expected: **FAIL** — `freeTier` does not exist on `ProviderDescriptor`.

### Step 3: Extend the provider descriptor

In `src/providers/registry.ts`, add to `ProviderDescriptor`:

```ts
/** Documented free-tier limits, sourced from plan/Free-Providers.txt and each
 *  provider's own docs. These are descriptive metadata for display only — they are
 *  NOT the scheduler's enforcement limits (those come from getRPMConfig).
 *  null = unknown; the UI renders "unknown" rather than guessing. */
freeTier?: {
  rpm?: number;           // requests per minute
  rpd?: number;           // requests per day
  tokensPerDay?: number;
  notes?: string;         // e.g. "no credit card required"
};
```

Add a lookup helper:

```ts
export function freeTierFor(name: string): ProviderDescriptor["freeTier"] | null {
  return PROVIDER_REGISTRY.find((d) => d.name === name)?.freeTier ?? null;
}
```

### Step 4: Populate from the research file

Fill `freeTier` for each provider using `plan/Free-Providers.txt` (checked into the repo). Representative values — **use null for anything the file does not state numerically, and never invent a number**:

| Provider | rpm | rpd | tokensPerDay | notes |
|---|---|---|---|---|
| agnes_ai | 25 | null | null | "permanently free, no credit card" |
| aionlabs | 15 | null | 20000 | "permanent free tier, no credit card" |
| kilocode | null | null | null | "~200 req/hr, 1M context" |
| glhf | 30 | null | null | "unlimited usage on free models" |
| nscale | null | null | null | "128K context" |
| nvidia | null | null | null | "1,000 free inference credits for new users" |
| speka | 10 | null | null | "$1 in monthly credits" |
| sambanova | null | 20 | 200000 | null |
| nexaapi | null | null | null | "free tier, no credit card" |
| orcarouter | null | null | null | "4 flagship models free ($0/token)" |
| openrouter, opencode_zen, groq, cerebras, gemini, mistral, ninerouter, tokenrouter, ollama | null | null | null | short note or omitted |

For `agnes_ai` the file says "20-30 RPM" — record `rpm: 25` and put "20-30 RPM documented" in `notes` so the UI can show the range rather than a false-precision single number.

### Step 5: Run the descriptor test

Run: `npx vitest run test/provider-limits.test.ts`
Expected: **PASS**

### Step 6: Add a daily-usage query

In `src/db/cooldown.ts`, next to the existing `getProviderRPMUsage` (:111), add:

```ts
/** Requests per provider in the trailing 24h — lets the UI show consumption
 *  against a documented daily quota. */
export async function getProviderDailyUsage(
  db: D1Database,
  windowMs = 86_400_000,
): Promise<Map<string, number>> { /* SELECT provider, COUNT(*) ... WHERE started_at >= ? GROUP BY provider */ }
```

Mirror the existing RPM function's shape and its try/catch-empty-map degradation. **Compute the cutoff in JS** and bind it as an ISO string — never `datetime('now', ...)` (see the `isoHoursAgo` comment in `src/api/shared.ts`; that exact bug caused a production outage).

### Step 7: Enrich `/api/providers`

In `src/api/providers.ts`, extend the enrichment block (was `routes.ts:82-101`) so each entry gains:

```ts
{
  ...row,
  baseUrl, modelsUrl, chatUrl,           // existing
  freeTier: freeTierFor(name),           // documented limits
  configuredRpm: rpmForProvider(name, getRPMConfig(env)),        // enforcement reality
  configuredConcurrency: capFor(name, getConcurrency(env as never)),
  usage24h: dailyUsage.get(name) ?? 0,   // observed consumption
}
```

Showing documented limits *and* configured enforcement *and* observed usage is the point — a provider whose configured RPM is far below its documented free tier is a tuning bug the dashboard should expose.

### Step 8: Surface it in the leaderboard

In `frontend/src/components/Leaderboard.tsx`, the `Provider` cell (:100-103) already builds `providerCdMap` (:63) with no extra hook needed. Add a compact limit badge beneath the provider pill, cloning the existing provider-cooldown badge classes:

```
text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-400 border border-zinc-700
```

Render `25 rpm` / `20 rpd` / `unknown` — **text only, no emoji**. Add `title` text with the full note so hovering reveals "20-30 RPM documented · permanently free, no credit card".

Pass the provider metadata down from `Dashboard.tsx` (it already fetches `/api/providers` at :31).

### Step 9: Run preflight

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

### Step 10: Commit

```bash
git add src/providers/registry.ts src/api/providers.ts src/db/cooldown.ts frontend/src test/provider-limits.test.ts
git commit -m "feat(providers): expose documented free-tier limits and 24h usage"
```

---

## Task 4: Public API docs page + OG share cards

**Files:**
- Create: `src/api/openapi.ts`, `src/api/og.ts`
- Modify: `src/index.ts:32-36` (route `/api/*` to Hono — OG + OpenAPI ride along automatically)
- Create: `frontend/src/pages/Docs.tsx`
- Modify: `frontend/src/App.tsx:8` (page union), `frontend/src/components/Header.tsx:5,28-55` (nav)
- Modify: `frontend/index.html` (OG meta tags)
- Test: `test/og.test.ts`, `test/openapi.test.ts` (new)

### Step 1: Write the failing OpenAPI test

Create `test/openapi.test.ts` asserting the generated spec lists every public GET route from the Task 1 inventory, that `security` is declared for the `/api/admin/*` paths, and that no path leaks an env var name or key material.

### Step 2: Run it to verify it fails

Run: `npx vitest run test/openapi.test.ts`
Expected: **FAIL** — `buildOpenApiSpec` does not exist.

### Step 3: Create `src/api/openapi.ts`

Hand-write an OpenAPI 3.1 document (no codegen dependency). Cover the **public read-only** surface in full — `/api/health`, `/api/providers`, `/api/models`, `/api/models/:id`, `/api/models/:id/history`, `/api/models/:id/incidents`, `/api/leaderboard`, `/api/history`, `/api/compare`, `/api/cooldowns` — including query parameters with types and defaults.

**Security requirement:** document `/api/admin/*` endpoints as `security: [{ bearerAuth: [] }]` but **do not enumerate internal parameter names or behaviour** beyond what is needed. Never serialise `env` — build the spec from a static literal so a future `env` field can never leak into the public document.

Register `GET /api/openapi.json` in `src/api/health.ts` (or a small `meta.ts`) returning it with `content-type: application/json`.

### Step 4: Run the OpenAPI test

Expected: **PASS**

### Step 5: Write the failing OG encoder test

Create `test/og.test.ts`. PNG encoding is pure and fully unit-testable:

```ts
import { describe, it, expect } from "vitest";
import { crc32, encodePng, renderOgCard } from "../src/api/og";

describe("png encoder", () => {
  it("computes known CRC32 values", () => {
    // CRC32 of "IEND" chunk type is a fixed, verifiable constant
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  it("emits a valid PNG signature and IHDR", async () => {
    const png = await encodePng(2, 2, new Uint8Array(2 * 2 * 4));
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBe(2); // width
    expect(dv.getUint32(20)).toBe(2); // height
  });

  it("renders a card containing the expected row count", async () => {
    const png = await renderOgCard([
      { rank: 1, name: "model-a", provider: "groq", tps: 120.5 },
    ]);
    expect(png.byteLength).toBeGreaterThan(1000);
  });
});
```

### Step 6: Run it to verify it fails

Expected: **FAIL** — module does not exist.

### Step 7: Implement the dependency-free PNG encoder

Create `src/api/og.ts`. Cloudflare Workers has no canvas, and adding a WASM rasteriser is a heavy dependency, so encode the PNG directly:

1. **`crc32(buf: Uint8Array): number`** — standard table-driven CRC-32 (IEEE), matching PNG's chunk checksum.
2. **`encodePng(width, height, rgba): Promise<Uint8Array>`** — assemble `IHDR` (bit depth 8, colour type 6 = RGBA), `IDAT`, `IEND`. Compress scanlines with `new CompressionStream("deflate")`, which per the WHATWG spec emits **zlib-wrapped deflate — exactly what PNG requires**. Each scanline must be prefixed with a `0` filter byte.
3. **`FONT_5X7`** — a compact bitmap font covering `A-Z`, `a-z`, `0-9` and `.:/-%+` encoded as per-glyph hex rows, drawn at 3× scale (15×21 px per glyph). Keep it a single const; it is data, not logic.
4. **`renderOgCard(rows)`** — 1200×630 (the standard OG dimension): dark `#0a0a0f` background matching the app, "ModelPulseX" title, "Top free models by throughput" subtitle, and up to five rows of `rank · name · provider · TPS`, plus a "measured <timestamp>" footer.

Keep drawing primitives minimal: `fillRect` and `drawText`. No anti-aliasing, no curves.

### Step 8: Run the OG test

Expected: **PASS**. Verify the CRC constant against a known value — if it is wrong the PNG will be corrupt even though the test's other assertions pass.

### Step 9: Register the OG route

Add `GET /api/og.png` returning `new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } })`.

Query the live leaderboard for the top 5 (reuse the existing scoring path, or a minimal `SELECT ... ORDER BY median_tps DESC LIMIT 5`). Wrap D1 access in try/catch: if the query fails, return a card with a "data unavailable" line rather than a 500 — a broken share image must never break a crawl.

### Step 10: Confirm the route is reachable

`src/index.ts:32` already forwards every `/api/*` path to the Hono app, so no change is needed there. Verify with `npm run dev` and `curl -s localhost:8787/api/og.png | head -c 8` → the PNG magic bytes `89 50 4e 47`.

### Step 11: Build the Docs page

Create `frontend/src/pages/Docs.tsx`:
- Fetch `/api/openapi.json`, render each path with its methods, parameters (name / type / default), and a copyable example `curl`
- Follow the `Methodology.tsx` page container: `max-w-[900px] mx-auto px-4 sm:px-6 py-8 space-y-8 text-zinc-300 leading-relaxed`
- Reuse the code-block style: `mono text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3`
- Provide a **table alternative** for every visual grouping (accessibility rule from the skill's chart guidance)

### Step 12: Wire up navigation

- `frontend/src/App.tsx:8` — widen the union to `"dashboard" | "methodology" | "admin" | "docs"`; add `const Docs = lazy(() => import("./pages/Docs"));`
- `App.tsx:21-27` — add an explicit `page === "docs" ? <Docs /> :` branch **before** the final `: <Methodology />`. The ternary chain is exhaustive-by-else, so without this docs silently renders Methodology.
- `Header.tsx:5` — widen `onNavigate`'s parameter union; add a fourth nav button copying the existing active/inactive className at `:31`

**Known limitation to accept:** there is no router in this app. Navigation is in-memory `useState`, so `/docs` is not deep-linkable — the same is already true of `/methodology` and `/admin`. Adding `react-router-dom` purely for this is out of scope; note it as follow-up work.

### Step 13: Add OG meta tags

In `frontend/index.html` (alongside the existing `<meta name="theme-color">` at :8):

```html
<meta property="og:title" content="ModelPulseX — Free LLM Performance Observatory" />
<meta property="og:description" content="Live streaming throughput, latency and reliability benchmarks for free LLM models." />
<meta property="og:image" content="https://modelpulsex.vipulgote5.workers.dev/api/og.png" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
```

### Step 14: Run preflight

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

**CI gap to be aware of:** `.github/workflows/ci.yml` runs lint + test + typecheck but **not** `npm run build`. A broken import in a new chart or page will pass CI and only fail at deploy. Run `npm run build` locally before finishing.

### Step 15: Commit

```bash
git add src/api/openapi.ts src/api/og.ts frontend/src frontend/index.html test
git commit -m "feat(docs): add public API docs page and OG share cards"
```

---

## Cross-cutting notes

**Migration application.** Task 2 adds `0009_itl.sql`. Apply locally with `npm run migrate:local` and remotely with `wrangler d1 migrations apply DB --remote` before deploying. Remote application needs a token with D1 permissions — the earlier `0006` migration hit exactly this and read `null` via graceful degradation until perms were granted.

**Deploy-order caution.** Task 2's code writes `itl_ms`, but the column only exists after the migration is applied remotely. Deploy the migration **first**, then the Worker. The try/catch guards in Step 12 keep the old code working either way.

**Typecheck scope.** `tsconfig.json:18` includes `src`, `frontend/src`, `test`, `vite.config.ts`. Frontend type errors will surface in `npm run typecheck` — the repeated inline `as unknown as Array<{...}>` casts in `Dashboard.tsx` are the most likely break point when adding row fields.

**Preflight before every commit:** `npm test && npm run typecheck && npm run lint`

---

## Explicit non-goals

- **ITL is not added to `overallScore`.** Reweighting silently reorders the leaderboard; that needs its own task and test.
- **No router is introduced.** Navigation stays in-memory, so `/docs` is not deep-linkable (consistent with the existing `/methodology` and `/admin`).
- **The leaderboard handler's internals are not refactored.** Task 1 moves it verbatim; its ~500 lines are a separate concern.
- **No new runtime dependencies.** The OG PNG encoder uses `CompressionStream`, which Workers already provide.
- **No frontend test framework is added.** Vitest is configured `environment: "node"` with `include: ["test/**/*.test.ts"]` and has no jsdom or testing-library, so new components are covered by typecheck + build, not unit tests.
