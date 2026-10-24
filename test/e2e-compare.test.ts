import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { compareRoutes } from "../src/api/compare";

function fakeEnv(
  snapshotRows: unknown[],
  raw24: unknown[] = [],
  raw7: unknown[] = [],
  metaIds?: number[],
) {
  const seen: string[] = [];
  const metas = (
    metaIds ?? (snapshotRows as Array<{ model_id: number }>).map((r) => r.model_id)
  ).map((id, i) => {
    const row = snapshotRows[i] as { provider?: string } | undefined;
    return {
      id,
      provider_model_id: `model-${id}`,
      display_name: `Model ${id}`,
      provider: row?.provider ?? `provider-${id}`,
    };
  });
  const db = {
    batch: async () => [
      { results: metas },
      { results: snapshotRows },
      { results: raw24 },
      { results: raw7 },
    ],
    prepare(sql: string) {
      seen.push(sql);
      const stmt = {
        bind() {
          return stmt;
        },
        all: async () => ({ results: [] }),
        first: async () => null,
      };
      return stmt;
    },
  };
  return { env: { DB: db } as never, seen };
}

vi.stubGlobal("caches", {
  default: { match: async () => undefined, put: async () => {} },
});

describe("compare e2e", () => {
  it("returns snapshot e2e medians and recommends by e2e_7d", async () => {
    const { env } = fakeEnv([
      {
        model_id: 1, provider: "alpha", tps_24h: 100, tps_7d: 90,
        e2e_tps_24h: 40, e2e_tps_7d: 35, ttft_24h: 300, ttft_7d: 310,
        uptime_7d: 0.99, error_rate_7d: 0.01, median_chunks_7d: 2,
      },
      {
        model_id: 2, provider: "beta", tps_24h: 400, tps_7d: 380,
        e2e_tps_24h: 300, e2e_tps_7d: 290, ttft_24h: 200, ttft_7d: 210,
        uptime_7d: 0.98, error_rate_7d: 0.02, median_chunks_7d: 370,
      },
    ]);
    const app = compareRoutes(env);
    const res = await app.request("/compare?models=1,2");
    const j = (await res.json()) as {
      compare: Array<Record<string, unknown>>;
      recommended_provider: string;
    };
    expect(j.compare[0]!.e2e_tps_7d).toBe(35);
    expect(j.compare[0]!.median_chunks_7d).toBe(2);
    // decode stays visible and distinct
    expect(j.compare[0]!.tps_7d).toBe(90);
    // model 2 wins on e2e even though it is "block delivery" by chunk count
    expect(j.recommended_provider).toBe("beta");
  });

  it("derives medians from raw runs when no snapshot row exists", async () => {    const { env } = fakeEnv(
      [],
      [
        { model_id: 1, gc_tps: "100,200,300", gc_e2e: "40,60,50", gc_ttft: "300,200,100", cnt: 3 },
      ],
      [
        {
          model_id: 1, gc_tps: "100,200,300,400,500", gc_e2e: "40,60,50,30,20",
          gc_ttft: "300,200,100,150,250", gc_chunks: "1,1,2,2,2", cnt: 5, ok7: 5,
        },
      ],
      [1],
    );
    const app = compareRoutes(env);
    const res = await app.request("/compare?models=1");
    const j = (await res.json()) as { compare: Array<Record<string, unknown>> };
    expect(j.compare[0]!.tps_24h).toBe(200);
    expect(j.compare[0]!.e2e_tps_24h).toBe(50);
    expect(j.compare[0]!.tps_7d).toBe(300);
    expect(j.compare[0]!.e2e_tps_7d).toBe(40);
    expect(j.compare[0]!.median_chunks_7d).toBe(2);
    expect(j.compare[0]!.uptime_7d).toBe(1);
  });
});

describe("compare cache key", () => {
  it("busts old decode-era cache entries", () => {
    const src = readFileSync("src/api/compare.ts", "utf8");
    expect(src).toContain("&v=2");
  });
});
