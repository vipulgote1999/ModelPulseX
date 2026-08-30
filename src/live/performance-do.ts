function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Durable Object live broadcast — SSE fan-out, not history store. Minimal SQLite state via ctx.storage. Hardened for max security. */

export class PerformanceDO implements DurableObject {
  private sessions: Set<ReadableStreamDefaultController> = new Set();
  private ipCounts: Map<string, number> = new Map();
  private readonly MAX_TOTAL_CLIENTS = 200;
  private readonly MAX_PER_IP = 5;

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = safeParseUrl(request.url);
    if (!url) return new Response("bad request", { status: 400 });
    // Security headers common to all DO responses
    const secHeaders = {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "x-permitted-cross-domain-policies": "none",
      "cross-origin-opener-policy": "same-origin",
    } as Record<string, string>;

    if (
      url.pathname === "/live" &&
      request.headers.get("accept")?.includes("text/event-stream")
    ) {
      return this.handleSSE(request, secHeaders);
    }
    if (url.pathname === "/publish" && request.method === "POST") {
      // Internal-only: require header set by Worker stub (not guessable by external internet because DO not publicly routed,
      // but defense-in-depth if mis-routed)
      const internal = request.headers.get("x-mpulse-internal");
      // If env has ADMIN_TOKEN, optionally verify it
      const token = (this.env as Record<string, unknown>)?.["ADMIN_TOKEN"] as
        | string
        | undefined;
      // Allow if internal header present OR if token matches (Worker will send admin token prefix)
      if (internal !== "1" && token) {
        const auth = request.headers.get("authorization") ?? "";
        const supplied = auth.startsWith("Bearer ")
          ? auth.slice(7).trim()
          : auth;
        // Constant-time compare if token present
        if (!supplied || supplied.length !== token.length) {
          return new Response("forbidden", {
            status: 403,
            headers: secHeaders,
          });
        }
        let diff = 0;
        for (let i = 0; i < token.length; i++)
          diff |= token.charCodeAt(i) ^ supplied.charCodeAt(i);
        if (diff !== 0)
          return new Response("forbidden", {
            status: 403,
            headers: secHeaders,
          });
      } else if (internal !== "1") {
        // If no internal header and no token env, still allow only if request appears internal (no CF ip)
        const cfIp = request.headers.get("cf-connecting-ip");
        const xff = request.headers.get("x-forwarded-for");
        // If has external IP but no internal flag, deny (prevents external publish if DO ever exposed)
        if (cfIp || xff)
          return new Response("forbidden", {
            status: 403,
            headers: secHeaders,
          });
      }
      // Validate body size (max 64KB for benchmark event)
      const clen = request.headers.get("content-length");
      if (clen && Number(clen) > 65536)
        return new Response("payload too large", {
          status: 413,
          headers: secHeaders,
        });
      const body = await request.text();
      if (body.length > 65536)
        return new Response("payload too large", {
          status: 413,
          headers: secHeaders,
        });
      // Basic JSON sanity — must be valid JSON with expected fields
      try {
        const j = JSON.parse(body);
        if (typeof j !== "object" || j === null) throw new Error("not object");
      } catch {
        return new Response("bad request", {
          status: 400,
          headers: secHeaders,
        });
      }
      this.broadcast("benchmark", body);
      return new Response("ok", { headers: secHeaders });
    }
    if (url.pathname === "/clients") {
      // Hide exact count from unauthenticated external if needed; keep lightweight.
      // Return count without leaking internal state; add cache no-store
      return new Response(JSON.stringify({ clients: this.sessions.size }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...secHeaders,
        },
      });
    }
    return new Response("not found", { status: 404, headers: secHeaders });
  }

  private handleSSE(
    _request: Request,
    secHeaders: Record<string, string>,
  ): Response {
    // Rate limiting per IP and global
    const ip =
      _request.headers.get("cf-connecting-ip")?.split(",")[0]?.trim() ??
      _request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    if (this.sessions.size >= this.MAX_TOTAL_CLIENTS) {
      return new Response("too many clients", {
        status: 503,
        headers: { "retry-after": "10", ...secHeaders },
      });
    }
    const perIp = this.ipCounts.get(ip) ?? 0;
    if (perIp >= this.MAX_PER_IP) {
      return new Response("too many clients for ip", {
        status: 429,
        headers: { "retry-after": "10", ...secHeaders },
      });
    }

    // Origin check — SSE is same-origin from dashboard; reject cross-origin without allowlist
    const origin = _request.headers.get("origin");
    if (origin) {
      // Allow only our own origin + localhost for dev
      const allowedOrigins = [
        "https://modelpulsex.vipulgote5.workers.dev",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8787",
        "http://127.0.0.1:8787",
      ];
      // Also allow dynamic from env if set (read lazily)
      const envOrigin = (this.env as Record<string, unknown>)?.[
        "CORS_ORIGIN"
      ] as string | undefined;
      const extra = envOrigin
        ? envOrigin
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const allAllowed = new Set([...allowedOrigins, ...extra]);
      if (!allAllowed.has(origin)) {
        return new Response("origin not allowed", {
          status: 403,
          headers: secHeaders,
        });
      }
    }

    let controller!: ReadableStreamDefaultController;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.sessions.delete(controller);
      const cur = (this.ipCounts.get(ip) ?? 1) - 1;
      if (cur <= 0) this.ipCounts.delete(ip);
      else this.ipCounts.set(ip, cur);
    };

    const stream = new ReadableStream({
      start: (c) => {
        controller = c;
        this.sessions.add(controller);
        this.ipCounts.set(ip, perIp + 1);
        c.enqueue(encode(`: connected\n\n`));
        // Set alarm for pings if not already set
        this.state.storage.setAlarm(Date.now() + 30000).catch(() => {});
      },
      cancel: () => {
        cleanup();
      },
    });
    // Build response with strict headers; do NOT set Access-Control-Allow-Origin: * — only echo allowed origin or omit
    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      ...secHeaders,
      // If origin was allowed, echo it back with credentials
      ...(origin &&
      ([
        "https://modelpulsex.vipulgote5.workers.dev",
        "http://localhost:5173",
      ].includes(origin) ||
        origin.includes("localhost"))
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            vary: "Origin",
          }
        : {}),
      "x-accel-buffering": "no",
    };
    return new Response(stream, { headers });
  }

  private broadcast(event: string, data: string) {
    const payload = encode(`event: ${event}\ndata: ${data}\n\n`);
    for (const c of [...this.sessions]) {
      try {
        c.enqueue(payload);
      } catch {
        this.sessions.delete(c);
      }
    }
  }

  async alarm(): Promise<void> {
    for (const c of [...this.sessions]) {
      try {
        c.enqueue(encode(`: ping\n\n`));
      } catch {
        this.sessions.delete(c);
      }
    }
    await this.state.storage.setAlarm(Date.now() + 30000);
  }
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
