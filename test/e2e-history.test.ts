import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { historyRoutes } from "../src/api/history";

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
          results: sql.includes("FROM hourly_model_stats")
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
});
