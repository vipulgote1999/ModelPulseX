import { describe, it, expect } from "vitest";
import {
  adminMaintenanceRoutes,
  clampBackfillDays,
} from "../src/api/admin/maintenance";

const TOKEN = "test-admin-token-0123456789abcdef";
const auth = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

function fakeDb(rows: Array<Record<string, unknown>>) {
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  let selects = 0;
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) {
          stmt.args = a;
          return stmt;
        },
        all: async () => {
          if (sql.includes("SELECT id")) {
            return { results: selects++ === 0 ? rows : [] };
          }
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    },
    batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => {
      for (const s of stmts) updates.push({ sql: s.sql, args: s.args });
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { db, updates };
}

describe("admin e2e maintenance", () => {
  it("clamps backfill days to 1..7 with a 7 default", () => {
    expect(clampBackfillDays(undefined)).toBe(7);
    expect(clampBackfillDays(0)).toBe(1);
    expect(clampBackfillDays(99)).toBe(7);
    expect(clampBackfillDays("3")).toBe(3);
    expect(clampBackfillDays(2.9)).toBe(2);
  });

  it("rejects unauthenticated backfill", async () => {
    const app = adminMaintenanceRoutes({ ADMIN_TOKEN: TOKEN } as never);
    const res = await app.request("/admin/backfill-e2e", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid reaggregate hour before touching D1", async () => {
    const app = adminMaintenanceRoutes({ ADMIN_TOKEN: TOKEN } as never);
    const res = await app.request("/admin/reaggregate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hour: "not-a-date" }),
    });
    expect(res.status).toBe(400);
  });

  it("backfills e2e from JS timestamps, not julianday precision", async () => {
    const { db, updates } = fakeDb([
      {
        id: 41,
        output_tokens: 279,
        started_at: "2026-10-24T00:00:00.000Z",
        completed_at: "2026-10-24T00:00:00.603Z",
      },
    ]);
    const app = adminMaintenanceRoutes({ ADMIN_TOKEN: TOKEN, DB: db } as never);
    const res = await app.request("/admin/backfill-e2e", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ days: 7 }),
    });
    const j = (await res.json()) as { ok: boolean; updated: number };
    expect(j.updated).toBe(1);
    // julianday rounds this row to 462.68; JS gives 462.69.
    expect(updates[0]!.args[0]).toBe(462.69);
    expect(updates[0]!.args[1]).toBe(41);
    expect(updates[0]!.sql).toContain("e2e_tps IS NULL");
  });
});
