import { Hono } from "hono";
import type { Env } from "../types";

export function liveRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/live", async () => {
    const stub = env.LIVE_DO.get(env.LIVE_DO.idFromName("global"));
    const req = new Request("https://live/live", {
      headers: { accept: "text/event-stream" },
    });
    return stub.fetch(req);
  });
  return r;
}
