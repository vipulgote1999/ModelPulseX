import { describe, it, expect } from "vitest";
import { adminModelsRoutes } from "../src/api/admin/models";

const TOKEN = "test-admin-token-0123456789abcdef";
const app = adminModelsRoutes({ ADMIN_TOKEN: TOKEN } as never);

function postBulk(body: unknown, token: string | null = TOKEN) {
  return app.request("/admin/models/bulk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("admin bulk hardening", () => {
  it("rejects unauthenticated bulk", async () => {
    const res = await postBulk({ enabled: true, all: true }, null);
    expect(res.status).toBe(401);
  });

  it("requires explicit enabled (no silent disable-all)", async () => {
    // Validation precedes any DB access, so no DB mock is needed.
    const res = await postBulk({ all: true });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error?: string };
    expect(j.error).toMatch(/enabled/);
  });
});
