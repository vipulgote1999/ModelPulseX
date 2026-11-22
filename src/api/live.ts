import { Hono } from "hono";
import type { Env } from "../types";

export function liveRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/live", async (c) => {
    const stub = env.LIVE_DO.get(env.LIVE_DO.idFromName("global"));
    // Forward identity headers into the DO. The DO enforces a per-IP SSE cap;
    // constructing a bare Request here made every visitor look like IP
    // "unknown", collapsing that cap into a global 5-client limit. Origin is
    // forwarded too so the DO's allowlist check sees the real caller.
    const headers: Record<string, string> = { accept: "text/event-stream" };
    for (const name of ["cf-connecting-ip", "x-forwarded-for", "origin"]) {
      const value = c.req.header(name);
      if (value) headers[name] = value;
    }
    const req = new Request("https://live/live", { headers });
    return stub.fetch(req);
  });
  return r;
}
