/** Query-parameter contracts published in /api/openapi.json.
 *
 *  The routes previously accepted any string for benchmark/sort/profile and
 *  silently fell back: `?benchmark=bogus` returned 200 with an empty board,
 *  `?sort=bogus` sorted by overall. Monitors and clients could not tell a typo
 *  from a real empty result. These cases pin the 400s.
 */
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/routes";

function dbStub() {
  return {
    prepare(stmt: string) {
      const obj = {
        bind() {
          return obj;
        },
        async first() {
          return /SELECT 1 as ok/.test(stmt) ? { ok: 1 } : null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return obj;
    },
    async batch() {
      return [];
    },
  };
}

const get = (path: string) =>
  createApi({ CORS_ORIGIN: "https://example.test", DB: dbStub() } as never)
    .request(`https://example.test${path}`);

describe("documented query enums", () => {
  for (const [path, field] of [
    ["/api/leaderboard?benchmark=bogus", "invalid benchmark"],
    ["/api/leaderboard?sort=bogus", "invalid sort"],
    ["/api/leaderboard?profile=bogus", "invalid profile"],
    ["/api/history?ids=1&benchmark=bogus", "invalid benchmark"],
    ["/api/history?ids=1&granularity=bogus", "invalid granularity"],
    ["/api/models/1/history?benchmark=bogus", "invalid benchmark"],
    ["/api/models/1/history?granularity=bogus", "invalid granularity"],
  ] as const) {
    it(`${path} returns 400 (${field})`, async () => {
      const res = await get(path);
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: string };
      expect(j.error).toBe(field);
    });
  }

  it("accepts the new speed benchmark value", async () => {
    // The snapshot/probe tables do have a `speed` bucket; rejecting it would
    // make a valid documented view look like a typo.
    const res = await get("/api/leaderboard?benchmark=speed");
    expect(res.status).not.toBe(400);
  });
});

describe("admin benchmark request contract", () => {
  const token = "test-admin-token-0123456789abcdef";
  const app = () =>
    createApi({
      CORS_ORIGIN: "https://example.test",
      ADMIN_TOKEN: token,
      DB: dbStub(),
      BENCH_QUEUE: { send: async () => undefined },
    } as never);
  const post = (body: unknown) =>
    app().request("https://example.test/api/admin/benchmark", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("rejects a non-integer model id before queueing", async () => {
    const res = await post({ model_id: "abc", benchmark_type: "coding" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown benchmark type instead of poisoning the queue", async () => {
    const res = await post({ model_id: 1, benchmark_type: "bogus" });
    expect(res.status).toBe(400);
  });
});
