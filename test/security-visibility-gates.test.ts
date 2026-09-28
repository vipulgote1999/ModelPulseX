/** SEC-002: public by-id routes must apply the same visibility gate as the list
 *  routes, and SEC-007: the resource-exhaustion fixes.
 *
 *  The bug these lock down: the list routes (`/api/models`,
 *  `/api/leaderboard`) deliberately hide paid, inactive, admin-disabled and
 *  registry-blacklisted models, but the by-id routes applied none of those
 *  gates — so an unauthenticated caller could read the full TPS/TTFT/uptime
 *  record for exactly the rows the rest of the app works to keep hidden.
 *
 *  A hidden model must 404 with the same body as a genuinely absent id, so the
 *  response never confirms that a paid or blacklisted row exists.
 */
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/routes";
import { publicModelVisibilityWhere } from "../src/providers/registry";

/** Model fixtures keyed by id, so a route's gate can be observed directly.
 *
 *  These mirror what the LIST routes actually hide, which is: admin-disabled
 *  rows (benchmark_enabled=0), fully inactive rows that are not
 *  PREVIOUSLY_FREE, and rows a provider's registry hard filter rejects.
 *  Note `free_status='PAID'` alone does NOT hide a row — the existing list
 *  gate is active/enabled/hard-filter, and these tests pin that same policy
 *  onto the detail routes so the two surfaces cannot diverge. */
const MODELS: Record<number, { free_status: string; active: number; benchmark_enabled: number | null; provider: string }> = {
  1: { free_status: "FREE", active: 1, benchmark_enabled: 1, provider: "openrouter" },
  // fully inactive and not PREVIOUSLY_FREE → hidden by the active gate
  2: { free_status: "FREE", active: 0, benchmark_enabled: 1, provider: "openrouter" },
  // admin-disabled → hidden by the benchmark_enabled gate
  3: { free_status: "FREE", active: 1, benchmark_enabled: 0, provider: "openrouter" },
  // PREVIOUSLY_FREE stays visible for the 7d retention window
  4: { free_status: "PREVIOUSLY_FREE", active: 0, benchmark_enabled: 1, provider: "openrouter" },
  // disabled AND inactive → hidden twice over
  5: { free_status: "FREE", active: 0, benchmark_enabled: 0, provider: "openrouter" },
};

/** Evaluate the visibility predicates the route put in its own SQL against a
 *  fixture row. Deliberately mechanical: it reads the emitted SQL rather than
 *  recomputing the policy, so a route that drops a gate fails the test. */
function passesGate(
  sql: string,
  m: { free_status: string; active: number; benchmark_enabled: number | null; provider: string } | undefined,
): boolean {
  if (!m) return false;
  if (/benchmark_enabled/.test(sql) && m.benchmark_enabled === 0) return false;
  // The active gate is emitted as (m.active=1 OR m.free_status='PREVIOUSLY_FREE').
  if (/active=1 OR m\.free_status='PREVIOUSLY_FREE'/.test(sql)) {
    if (!(m.active === 1 || m.free_status === "PREVIOUSLY_FREE")) return false;
  }
  return true;
}

/** D1 stub that serves `models` lookups and empty aggregates. */
function dbStub() {
  const sql: string[] = [];
  return {
    sql,
    prepare(stmt: string) {
      sql.push(stmt);
      return {
        bind(...args: unknown[]) {
          return {
            // Visibility probe: SELECT 1 as ok FROM models m JOIN providers p ...
            first: async () => {
              if (/SELECT 1 as ok FROM models/i.test(stmt)) {
                const id = Number(args[0]);
                const m = MODELS[id];
                // Evaluate the gate the route actually built, rather than
                // re-deriving it here — otherwise the stub would agree with a
                // buggy route by construction and the test would prove nothing.
                return passesGate(stmt, m) ? { ok: 1 } : null;
              }
              // Plain model fetch by id (the /models/:id row itself).
              if (/SELECT m\.\*/i.test(stmt)) {
                const id = Number(args[0]);
                const m = MODELS[id];
                if (!m) return null;
                return { id, ...m, display_name: `model-${id}` };
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
    batch: async () => [],
  };
}

const get = (path: string) =>
  createApi({ CORS_ORIGIN: "https://example.test", DB: dbStub() } as never)
    .request(`https://example.test${path}`);

describe("publicModelVisibilityWhere", () => {
  it("always gates benchmark_enabled", () => {
    expect(publicModelVisibilityWhere("p", "m")).toContain("benchmark_enabled");
  });

  it("gates active by default", () => {
    expect(publicModelVisibilityWhere("p", "m")).toContain("active=1");
  });

  it("includeInactive relaxes ONLY the active gate", () => {
    const relaxed = publicModelVisibilityWhere("p", "m", { includeInactive: true });
    expect(relaxed).not.toContain("active=1");
    // The gates that hide disabled/polluted rows must survive the relaxation,
    // otherwise includeInactive=1 becomes a way to read everything.
    expect(relaxed).toContain("benchmark_enabled");
  });

  it("includes registry hard filters when the registry declares any", () => {
    // At least one provider ships a hardFreeFilter, so the fragment must carry
    // an OR-based provider exclusion rather than being empty.
    const w = publicModelVisibilityWhere("p", "m");
    expect(w).toContain("p.name !=");
  });
});

describe("GET /api/models/:id (SEC-002)", () => {
  it("returns a visible FREE+active+enabled model", async () => {
    const res = await get("/api/models/1");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { model: { id: number } };
    expect(j.model.id).toBe(1);
  });

  it("404s a fully-inactive model — same body as a missing id", async () => {
    const hidden = await get("/api/models/2");
    const missing = await get("/api/models/999");
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    // Identical bodies: the response must not reveal that id 2 exists.
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it("404s an admin-disabled model", async () => {
    expect((await get("/api/models/3")).status).toBe(404);
  });

  it("404s a model that is both disabled and inactive", async () => {
    expect((await get("/api/models/5")).status).toBe(404);
  });

  it("allows PREVIOUSLY_FREE (kept visible for the 7d retention window)", async () => {
    expect((await get("/api/models/4")).status).toBe(200);
  });

  it("rejects a malformed id with 400", async () => {
    expect((await get("/api/models/abc")).status).toBe(400);
  });
});

describe("GET /api/models/:id/history (SEC-002)", () => {
  it("404s a hidden model before running any aggregate query", async () => {
    const db = dbStub();
    const app = createApi({ CORS_ORIGIN: "https://example.test", DB: db } as never);
    // id 2 is fully inactive → hidden by the active gate.
    const res = await app.request("https://example.test/api/models/2/history");
    expect(res.status).toBe(404);
    // The gate must run first — no hourly/tenmin/raw scan for a hidden row.
    expect(db.sql.some((s) => /hourly_model_stats|tenmin_model_stats|benchmark_runs/.test(s))).toBe(false);
  });

  it("rejects a malformed id with 400 instead of querying with NaN", async () => {
    // Previously this route had no finite-check, unlike its siblings: a NaN
    // went straight into the bound query.
    expect((await get("/api/models/abc/history")).status).toBe(400);
  });
});

describe("GET /api/models/:id/incidents (SEC-002)", () => {
  it("404s a hidden model", async () => {
    expect((await get("/api/models/2/incidents")).status).toBe(404);
  });

  it("404s an admin-disabled model", async () => {
    expect((await get("/api/models/3/incidents")).status).toBe(404);
  });

  it("rejects a malformed id with 400", async () => {
    expect((await get("/api/models/abc/incidents")).status).toBe(400);
  });
});

describe("GET /api/compare (SEC-002 + SEC-007)", () => {
  it("404s when a search term only matches hidden models", async () => {
    // The id resolution query now carries the visibility gate, so a paid or
    // disabled model is not resolvable by name.
    const db = dbStub();
    const app = createApi({ CORS_ORIGIN: "https://example.test", DB: db } as never);
    const res = await app.request("https://example.test/api/compare?model=stealth");
    expect(res.status).toBe(404);
    const gated = db.sql.filter((s) => /provider_model_id LIKE/.test(s));
    expect(gated.length).toBeGreaterThan(0);
    expect(gated[0]).toContain("benchmark_enabled");
  });

  it("bounds the name search with a LIMIT (SEC-007)", async () => {
    // The unanchored LIKE was a full scan of `models` with no LIMIT on an
    // unauthenticated route.
    const db = dbStub();
    const app = createApi({ CORS_ORIGIN: "https://example.test", DB: db } as never);
    await app.request("https://example.test/api/compare?model=anything");
    const search = db.sql.find((s) => /provider_model_id LIKE/.test(s));
    expect(search).toMatch(/LIMIT\s+\d+/i);
  });
});

describe("GET /api/models (SEC-007)", () => {
  it("bounds the catalogue read with a LIMIT", async () => {
    const db = dbStub();
    const app = createApi({ CORS_ORIGIN: "https://example.test", DB: db } as never);
    await app.request("https://example.test/api/models");
    const list = db.sql.find((s) => /SELECT m\.\*/i.test(s));
    expect(list).toMatch(/LIMIT\s+\d+/i);
  });

  it("still applies the hard-filter gate on the list route", async () => {
    const db = dbStub();
    const app = createApi({ CORS_ORIGIN: "https://example.test", DB: db } as never);
    await app.request("https://example.test/api/models");
    const list = db.sql.find((s) => /SELECT m\.\*/i.test(s))!;
    expect(list).toContain("benchmark_enabled");
    expect(list).toContain("p.name !=");
  });

  it("includeInactive=1 does not bypass the enabled/hard-filter gates", async () => {
    const db = dbStub();
    const app = createApi({ CORS_ORIGIN: "https://example.test", DB: db } as never);
    await app.request("https://example.test/api/models?includeInactive=1");
    const list = db.sql.find((s) => /SELECT m\.\*/i.test(s))!;
    expect(list).toContain("benchmark_enabled");
    expect(list).toContain("p.name !=");
    expect(list).not.toContain("active=1");
  });
});
