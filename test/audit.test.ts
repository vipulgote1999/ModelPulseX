import { describe, it, expect, vi, afterEach } from "vitest";
import { recordAudit, fingerprint } from "../src/db/audit";
import { createApi } from "../src/api/routes";

/** Capturing D1 stub: records INSERT binds, serves SELECTs with null. */
function capturingDb(opts: { failAuditInsert?: boolean } = {}) {
  const inserts: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    inserts,
    prepare(sql: string) {
      const stmt = {
        bind(...binds: unknown[]) {
          return {
            first: async () => null,
            run: async () => {
              if (opts.failAuditInsert)
                throw new Error("D1_ERROR: no such table: audit_log");
              if (sql.includes("INSERT INTO audit_log")) inserts.push({ sql, binds });
              return { meta: { changes: 1 } };
            },
          };
        },
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    },
  };
  return db;
}

const TOKEN = "a-strong-admin-token-0123456789";

describe("audit fingerprint", () => {
  it("is stable, short, and not the input", async () => {
    const a = await fingerprint(TOKEN);
    expect(a).toBe(await fingerprint(TOKEN));
    expect(a).toHaveLength(16);
    expect(a).not.toContain(TOKEN);
    expect(await fingerprint("other")).not.toBe(a);
  });
});

describe("recordAudit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores a fingerprint instead of the raw credential", async () => {
    const db = capturingDb();
    const ok = await recordAudit(db as never, {
      action: "post /api/admin/benchmark",
      actor: TOKEN,
      ip: "203.0.113.7",
      userAgent: "x".repeat(500),
      details: { status: 200 },
    });
    expect(ok).toBe(true);
    expect(db.inserts).toHaveLength(1);
    const [row] = db.inserts;
    expect(row!.sql).toContain("INSERT INTO audit_log");
    expect(JSON.stringify(row!.binds)).not.toContain(TOKEN);
    expect(row!.binds).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      "post /api/admin/benchmark",
      await fingerprint(TOKEN),
      "203.0.113.7",
      "x".repeat(200), // ua capped
      null,
      JSON.stringify({ status: 200 }),
    ]);
  });

  it("marks a credential-less action as anonymous", async () => {
    const db = capturingDb();
    await recordAudit(db as never, { action: "post /api/admin/login", actor: "" });
    expect(db.inserts[0]!.binds[2]).toBe("anonymous");
  });

  it("returns false instead of throwing when the table is missing (pre-migration)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = capturingDb({ failAuditInsert: true });
    await expect(
      recordAudit(db as never, { action: "post /api/admin/cleanup", actor: TOKEN }),
    ).resolves.toBe(false);
    expect(err).toHaveBeenCalled();
  });
});

describe("admin route auditing (issue #20)", () => {
  it("records a denied admin call (brute-force signal) and still returns 401", async () => {
    const env = {
      CORS_ORIGIN: "https://example.test",
      ADMIN_TOKEN: TOKEN,
      DB: capturingDb(),
    };
    const res = await createApi(env as never).request(
      "https://example.test/api/admin/benchmark",
      { method: "POST", body: JSON.stringify({ model_id: 1 }) },
    );
    expect(res.status).toBe(401);
    const inserts = (env.DB as unknown as { inserts: Array<{ binds: unknown[] }> })
      .inserts;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.binds[1]).toBe("post /api/admin/benchmark");
    expect(inserts[0]!.binds[2]).toBe("anonymous");
    expect(inserts[0]!.binds[6]).toBe(JSON.stringify({ status: 401 }));
  });

  it("records an authorized admin call with a fingerprinted actor", async () => {
    const env = {
      CORS_ORIGIN: "https://example.test",
      ADMIN_TOKEN: TOKEN,
      DB: capturingDb(),
    };
    const res = await createApi(env as never).request(
      "https://example.test/api/admin/benchmark",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ model_id: 1 }),
      },
    );
    // model_id 1 does not exist in the stub → 404, but the call WAS authorized
    expect(res.status).toBe(404);
    const inserts = (env.DB as unknown as { inserts: Array<{ binds: unknown[] }> })
      .inserts;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.binds[2]).toBe(await fingerprint(`Bearer ${TOKEN}`));
    expect(String(inserts[0]!.binds[2])).not.toContain(TOKEN);
  });

  it("audits every admin router (models + maintenance), not just the main one", async () => {
    const env = {
      CORS_ORIGIN: "https://example.test",
      ADMIN_TOKEN: TOKEN,
      DB: capturingDb(),
    };
    const api = createApi(env as never);
    for (const path of ["/api/admin/models/1/toggle", "/api/admin/cleanup"]) {
      const res = await api.request(`https://example.test${path}`, { method: "POST" });
      expect(res.status).toBe(401);
    }
    const inserts = (env.DB as unknown as { inserts: Array<{ binds: unknown[] }> })
      .inserts;
    expect(inserts.map((i) => i.binds[1])).toEqual([
      "post /api/admin/models/1/toggle",
      "post /api/admin/cleanup",
    ]);
  });
});
