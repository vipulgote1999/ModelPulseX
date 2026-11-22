import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { historyRoutes } from "../src/api/history";
import { modelsRoutes } from "../src/api/models";

function fakeDb() {
  const seen: string[] = [];
  const db = {
    prepare(sql: string) {
      seen.push(sql);
      const stmt = {
        bind() {
          return stmt;
        },
        all: async () => ({
          results: sql.includes("SELECT m.id FROM models")
            ? [{ id: 1 }]
            : sql.includes("FROM hourly_model_stats")
              ? [
                  {
                    model_id: 1,
                    hour_start: "2026-10-24T00:00:00.000Z",
                    median_tps: 800,
                    median_e2e_tps: 220,
                    median_ttft: 400,
                    success_rate: 1,
                    uptime: 1,
                    request_count: 5,
                  },
                ]
              : [],
        }),
      };
      return stmt;
    },
  };
  return { db, seen };
}

describe("history e2e", () => {
  it("returns median_e2e_tps and keeps median_tps as decode", async () => {
    const { db, seen } = fakeDb();
    const app = historyRoutes({ DB: db } as never);
    const res = await app.request("/history?ids=1&range=7d&benchmark=all");
    const j = (await res.json()) as {
      history: Record<number, Array<Record<string, number>>>;
    };
    expect(j.history[1]![0]!.median_tps).toBe(800);
    expect(j.history[1]![0]!.median_e2e_tps).toBe(220);
    expect(seen.some((s) => s.includes("median_e2e_tps"))).toBe(true);
  });

  it("keeps the raw fallback's e2e value distinct from decode", () => {
    const src = readFileSync("src/api/history.ts", "utf8");
    expect(src).toContain("e2e_tps as median_e2e_tps");
    expect(src).toContain("median_e2e_tps");
  });

  it("per-model history raw fallback also returns e2e, ITL, and chunk count", async () => {
    let rawSql = "";
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() {
            return stmt;
          },
          all: async () => {
            if (sql.includes("FROM hourly_model_stats")) return { results: [] };
            if (sql.includes("FROM benchmark_runs")) {
              rawSql = sql;
              return {
                results: [
                  {
                    hour_start: "2026-11-22T09:00:00.000Z",
                    median_tps: 800,
                    median_e2e_tps: 220,
                    median_itl: 12,
                    chunk_count: 9,
                    success_rate: 1,
                    uptime: 1,
                    request_count: 1,
                  },
                ],
              };
            }
            return { results: [] };
          },
          first: async () => {
            if (sql.includes("SELECT 1 as ok")) return { ok: 1 };
            if (sql.includes("count(*)")) return { c: 1, first: "2026-11-22T09:00:00.000Z" };
            return null;
          },
        };
        return stmt;
      },
    };
    const app = modelsRoutes({ DB: db } as never);
    const res = await app.request("/models/1/history?range=7d&benchmark=all");
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      history: Array<Record<string, number>>;
    };
    expect(j.history[0]!.median_e2e_tps).toBe(220);
    expect(j.history[0]!.median_tps).toBe(800);
    expect(j.history[0]!.median_itl).toBe(12);
    expect(j.history[0]!.chunk_count).toBe(9);
    expect(rawSql).toContain("e2e_tps as median_e2e_tps");
    expect(rawSql).toContain("chunk_count");
  });
});
