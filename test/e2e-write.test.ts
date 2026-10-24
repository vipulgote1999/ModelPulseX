import { describe, it, expect } from "vitest";
import { insertBenchmarkRun } from "../src/db/queries";
import type { BenchmarkResult } from "../src/types";

function captureDb() {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) { stmt.args = args; return stmt; },
        run: async () => ({ meta: { last_row_id: 1 } }),
        all: async () => ({ results: [] }),
      };
      statements.push(stmt);
      return stmt;
    },
    batch: async (stmts: unknown[]) => {
      void stmts;
      return [{ meta: { last_row_id: 1 } }];
    },
  };
  return { db, statements };
}

describe("insertBenchmarkRun — e2e", () => {
  it("writes e2e_tps and carries it into last_now_json", async () => {
    const { db, statements } = captureDb();
    const run = {
      benchmark_type: "coding", request_started_at: "2026-10-24T00:00:00.000Z",
      first_token_at: "2026-10-24T00:00:00.472Z", request_completed_at: "2026-10-24T00:00:00.603Z",
      input_tokens: 10, output_tokens: 279, ttft_ms: 472, generation_ms: 131,
      tps: 2129.77, e2e_tps: 462.69, itl_ms: 131, chunk_count: 2, status: "SUCCESS",
      error_type: null, http_status: 200, provider: "openrouter",
      model: "test:free", token_estimation_method: "provider",
    } as BenchmarkResult;
    await insertBenchmarkRun(db as never, 1, run);
    const insert = statements.find((s) => s.sql.includes("INSERT INTO benchmark_runs"))!;
    expect(insert.sql).toContain("e2e_tps");
    expect(insert.args[10]).toBe(462.69); // after tps
    const overlay = statements.find((s) => s.sql.includes("last_now_json"))!;
    const payload = JSON.parse(overlay.args[1] as string) as Record<string, { e2e: number }>;
    expect(payload.coding!.e2e).toBe(462.69);
  });
});
