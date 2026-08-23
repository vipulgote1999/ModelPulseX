/** Durable Object live broadcast — SSE fan-out, not history store. Minimal SQLite state via ctx.storage. */

export class PerformanceDO implements DurableObject {
  private sessions: Set<ReadableStreamDefaultController> = new Set();

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/live" && request.headers.get("accept")?.includes("text/event-stream")) {
      return this.handleSSE(request);
    }
    if (url.pathname === "/publish" && request.method === "POST") {
      const body = await request.text();
      this.broadcast("benchmark", body);
      return new Response("ok");
    }
    if (url.pathname === "/clients") {
      return new Response(JSON.stringify({ clients: this.sessions.size }));
    }
    return new Response("not found", { status: 404 });
  }

  private handleSSE(_request: Request): Response {
    let controller!: ReadableStreamDefaultController;
    const stream = new ReadableStream({
      start: (c) => {
        controller = c;
        // send hello
        c.enqueue(encode(`: connected\n\n`));
      },
      cancel: () => {
        this.sessions.delete(controller);
      },
    });
    this.sessions.add(controller);
    // keep session until client disconnects; do not persist history
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
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
    // optional keepalive ping every 30s for stale clients
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
