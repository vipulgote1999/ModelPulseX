/** SEC-007: cache-key cardinality on the six cached public routes.
 *
 *  The defect: every cached route keyed on the raw request URL, which includes
 *  arbitrary query params. `?x=<random>` therefore minted a new cache object AND
 *  forced a fresh origin D1 read for a byte-identical response. On
 *  `/api/leaderboard` that is a ~9k-row read; on `/api/og.png` it is a 7d raw
 *  scan plus a 1200x630 PNG encode. Unauthenticated, so the cost is entirely
 *  attacker-controlled.
 *
 *  The fix keys each route on only the params its response actually varies by.
 *  These tests observe the cache API directly, so they fail if a key ever
 *  regresses to the full URL.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createApi } from "../src/api/routes";

/** Stub the Workers cache API and record every key it is asked about. */
let putKeys: string[] = [];
let matchKeys: string[] = [];
let store = new Map<string, Response>();

function installCache() {
  putKeys = [];
  matchKeys = [];
  store = new Map();
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async (req: Request) => {
        matchKeys.push(req.url);
        return store.get(req.url) ?? undefined;
      },
      put: async (req: Request, res: Response) => {
        putKeys.push(req.url);
        store.set(req.url, res);
      },
    },
  };
}

/** D1 stub: every statement returns empty, batch returns empty rows. */
const dbStub = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 0 } }),
  }),
  batch: async () => [],
};

const app = () =>
  createApi({ CORS_ORIGIN: "https://example.test", DB: dbStub } as never);

const get = (path: string) => app().request(`https://example.test${path}`);

beforeEach(() => {
  installCache();
  vi.stubGlobal("caches", (globalThis as unknown as { caches: unknown }).caches);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("param-less cached routes key on origin+path only", () => {
  // These three routes read no query params at all, so every query string must
  // collapse to one cache entry.
  for (const path of ["/api/cooldowns", "/api/providers", "/api/og.png"]) {
    it(`${path} collapses junk query params to a single cache key`, async () => {
      await get(path);
      await get(`${path}?x=random-1`);
      await get(`${path}?x=random-2`);
      const keys = new Set([...matchKeys, ...putKeys]);
      expect(keys.size, `keys seen: ${[...keys].join(", ")}`).toBe(1);
      expect([...keys][0]).toBe(`https://example.test${path}`);
    });
  }
});

describe("/api/leaderboard cache key", () => {
  it("keys on the four params it varies by, not the raw URL", async () => {
    await get("/api/leaderboard?range=7d&benchmark=all&sort=tps&profile=balanced");
    const key = [...new Set([...matchKeys, ...putKeys])][0]!;
    for (const p of ["range", "benchmark", "sort", "profile"])
      expect(key).toContain(p);
    // The unrecognised param must not appear anywhere in the key.
    expect(key).not.toContain("x=");
  });

  it("collapses an unrecognised param to the same key as the bare request", async () => {
    await get("/api/leaderboard?range=7d&benchmark=all&sort=tps&profile=balanced");
    await get("/api/leaderboard?range=7d&benchmark=all&sort=tps&profile=balanced&junk=abc");
    expect(new Set([...matchKeys, ...putKeys]).size).toBe(1);
  });

  it("keeps genuinely different views in separate entries", async () => {
    await get("/api/leaderboard?range=7d&sort=tps");
    await get("/api/leaderboard?range=7d&sort=ttft");
    expect(new Set([...matchKeys, ...putKeys]).size).toBe(2);
  });

  it("does not cache the empty/transient response (SEC-007)", async () => {
    // The DB stub returns no models, so this takes the empty fast path. It must
    // not be written to the shared cache, or one unlucky read serves an empty
    // leaderboard to every visitor.
    const res = await get("/api/leaderboard");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(putKeys.filter((k) => k.includes("/api/leaderboard"))).toHaveLength(0);
  });
});

describe("/api/compare cache key", () => {
  it("keys on the resolved id set, not the raw URL", async () => {
    await get("/api/compare?models=1,2");
    const key = [...new Set([...matchKeys, ...putKeys])][0]!;
    expect(key).toContain("ids=1,2");
  });

  it("collapses a junk param for the same id set", async () => {
    await get("/api/compare?models=1,2");
    await get("/api/compare?models=1,2&junk=zzz");
    expect(new Set([...matchKeys, ...putKeys]).size).toBe(1);
  });

  it("keeps different id sets separate", async () => {
    await get("/api/compare?models=1,2");
    await get("/api/compare?models=1,3");
    expect(new Set([...matchKeys, ...putKeys]).size).toBe(2);
  });
});

describe("/api/timeouts cache key", () => {
  it("keys on the validated range only", async () => {
    await get("/api/timeouts?range=7d");
    const key = [...new Set([...matchKeys, ...putKeys])][0]!;
    expect(key).toContain("range=7d");
    expect(key).not.toContain("junk");
  });
});
