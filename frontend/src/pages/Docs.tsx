import { useEffect, useState } from "react";

type OpenApiSpec = {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, { summary?: string; description?: string; parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>; security?: unknown[] }>>;
};

export default function Docs() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/openapi.json").then((r) => r.json()).then((j) => setSpec(j as OpenApiSpec)).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 text-amber-300">Failed to load API docs: {error}</div>;
  if (!spec) return <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 text-zinc-400 animate-pulse">Loading API docs…</div>;

  const base = "https://modelpulsex.vipulgote5.workers.dev";

  return (
    <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 space-y-8 text-zinc-300 leading-relaxed">
      <div>
        <h1 className="text-2xl font-bold text-white">API Documentation</h1>
        <p className="text-sm text-zinc-400 mt-2">{spec.info.description}</p>
        <p className="text-xs text-zinc-500 mt-1">OpenAPI {spec.openapi} · version {spec.info.version} · server <span className="mono text-zinc-300">{base}</span></p>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Quick start</h2>
        <pre className="mono text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto">curl {base}/api/leaderboard?range=7d | jq .leaderboard[0]
curl {base}/api/history?ids=1,2,3&amp;range=7d | jq .history
curl {base}/api/health?freshness=15
# share card
open {base}/api/og.png</pre>
        <p className="text-sm text-zinc-500">All public GET endpoints are unauthenticated. Admin endpoints require <code className="mono text-xs bg-zinc-800 px-1 py-0.5 rounded">Authorization: Bearer $ADMIN_TOKEN</code>.</p>
      </section>

      <section className="space-y-6">
        <h2 className="font-semibold text-white text-lg">Endpoints</h2>
        {Object.entries(spec.paths).map(([path, methods]) => (
          <div key={path} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
            <div className="font-mono text-sm text-violet-300 break-all">{path}</div>
            {Object.entries(methods).map(([method, op]) => (
              <div key={method} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded font-mono border ${method === "get" ? "bg-sky-900/30 text-sky-300 border-sky-800" : "bg-amber-900/30 text-amber-300 border-amber-800"}`}>{method.toUpperCase()}</span>
                  <span className="text-sm text-white">{(op as { summary?: string }).summary ?? ""}</span>
                  {(op as { security?: unknown[] }).security && <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400">auth required</span>}
                </div>
                {(op as { parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }> }).parameters && (
                  <table className="w-full text-xs border border-zinc-800 rounded-lg overflow-hidden">
                    <thead className="bg-zinc-900 text-zinc-400 text-[11px] tracking-widest">
                      <tr><th className="text-left px-2 py-1">Name</th><th className="text-left px-2 py-1">In</th><th className="text-left px-2 py-1">Required</th><th className="text-left px-2 py-1">Schema</th></tr>
                    </thead>
                    <tbody>
                      {(op as { parameters: Array<{ name: string; in: string; required?: boolean; schema?: unknown }> }).parameters.map((p) => (
                        <tr key={p.name} className="border-t border-zinc-800">
                          <td className="px-2 py-1 mono text-zinc-300">{p.name}</td>
                          <td className="px-2 py-1 text-zinc-400">{p.in}</td>
                          <td className="px-2 py-1 text-zinc-400">{p.required ? "yes" : "no"}</td>
                          <td className="px-2 py-1 mono text-zinc-500 text-[11px]">{JSON.stringify(p.schema)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <pre className="mono text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto">curl {base}{path.replace("{id}", "1").replace("{id}", "1")}</pre>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-xs text-zinc-500">
        <b className="text-zinc-300">Notes:</b> This document is hand-written OpenAPI 3.1 (no codegen) so it can never leak internal env keys. Range values are <code>1h|24h|3d|7d</code>, benchmark <code>all|short|medium|coding</code>, sort <code>overall|tps|ttft|uptime</code>, profile <code>balanced|fastest|latency|reliable|coding</code>. History batch endpoint accepts up to 12 ids and supports <code>granularity=10m</code> for 1h live lines.
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-2">
        <h2 className="font-semibold text-white">OG share card</h2>
        <p className="text-sm">Embed the live leaderboard as an image: <code className="mono text-xs bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5">{base}/api/og.png</code>. Returns 1200×630 PNG, dark theme, top 5 models, 5-minute cache.</p>
        <img src="/api/og.png" alt="OG preview" className="rounded-lg border border-zinc-800 w-full max-w-[600px] aspect-[1200/630] object-cover bg-[#0a0a0f]" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      </section>
    </div>
  );
}
