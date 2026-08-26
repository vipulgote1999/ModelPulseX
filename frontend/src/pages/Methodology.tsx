export default function Methodology() {
  return (
    <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 space-y-8 text-zinc-300 leading-relaxed">
      <h1 className="text-2xl font-bold text-white">Methodology — ModelPulseX Transparency</h1>
      <p className="text-sm text-zinc-400">Every number shown traces back to a real streaming benchmark. No fake historical values. When only 2 hours of data exists, we show “2h of observed data” rather than pretending 7 days exists. Windowed figures are <b>medians</b>, and any window with fewer samples than our minimum-sample threshold shows nothing rather than a misleading number.</p>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">How TPS is measured — Measured TPS</h2>
        <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 mono text-xs">generation_time = completed_at - first_token_at
TPS = output_tokens / generation_time (seconds)</pre>
        <p className="text-sm">We do NOT use total request duration. We record <b>request_started_at</b>, <b>first_token_at</b> (first SSE <code>data:</code> with content), <b>completed_at</b>. If provider supplies <code>usage.completion_tokens</code> we use it and mark <code>Measured TPS</code> with <code>token_estimation_method=provider</code>; otherwise we estimate via char/4 heuristic flagged <code>heuristic</code> and clearly indicate estimation.</p>
        <p className="text-sm">Windowed values (1h/24h/7d) are <b>medians (P50)</b> over the window — matching how sustained provider performance is reported in the industry — not averages, which a single 2-sample spike can distort. “TPS Now” is the single latest measurement and is labeled accordingly. Windows need at least <b>2 samples (1h)</b>, <b>3 samples (24h)</b> or <b>5 samples (7d)</b> before a figure is displayed; below that you get “insufficient data” instead of noise. Hourly aggregates also retain p50/p90/p95 for both TPS and TTFT.</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">TTFT</h2>
        <pre className="mono text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3">TTFT = first_token_at - request_started_at</pre>
        <p className="text-sm">Reported as TTFT Now / 1h / 24h / 7d with p50/p90/p95 per hourly aggregate window.</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Benchmark workloads (deterministic per benchmark_type)</h2>
        <ul className="list-disc pl-6 text-sm space-y-1">
          <li><b>short</b>: “Return exactly: PONG” — 16 max_tokens, measures latency/TTFT.</li>
          <li><b>medium</b>: 180–220 word summary — measures sustained generation/TPS.</li>
          <li><b>coding</b>: Python two-sum with complexity + test — measures coding quality + sustained.</li>
        </ul>
        <p className="text-sm text-zinc-500">Same prompt for all models within a benchmark_type; never compare across types as identical workloads.</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Free-model detection</h2>
        <ul className="list-disc pl-6 text-sm">
          <li>OpenRouter: pricing.prompt == 0 && pricing.completion == 0 (both zero). If either side &gt;0 → FREE_STATUS=UNKNOWN and not benchmarked.</li>
          <li>OpenCode Zen: id ends with -free or exact `big-pickle`; if pricing unknown but suffix matches → FREE. Others → UNKNOWN skip. Frontend shows <span className="text-amber-300">Previously Free</span> when FREE → PAID transition; historical kept 7d but no new scheduling.</li>
          <li>Before queuing any job we call verifyFree(model); skip if UNKNOWN.</li>
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Frequency, aggregation, retention</h2>
        <ul className="list-disc pl-6 text-sm">
          <li>Cron <code>*/5 * * * *</code> selects jobs by least-recently-benchmarked rotation (respecting per-provider RPM/concurrency budgets), enqueues them via Queue (batch 10, 3 retries, consumer concurrency 8), and runs the first few inline as a delivery fallback. A scheduler heartbeat (enqueue counts, skips) is persisted every tick and exposed via <code>/api/health</code> and leaderboard meta.</li>
          <li>Cron <code>0 * * * *</code> re-discovers (churn), computes hourly aggregates (avg/median/p90/p95 TPS/TTFT, success_rate, uptime), cleans up, and runs a staleness watchdog that alerts an optional webhook if no measurement lands within the stale threshold.</li>
          <li>Providers failing repeatedly on quota/rate-limits back off exponentially (up to 2h cooldowns honoring <code>Retry-After</code>) so dead keys don’t burn benchmark capacity.</li>
          <li>Retention: raw benchmark_runs 7–14 days, hourly aggregates 30–90 days, daily/model metadata/incidents indefinite. No response bodies stored. This keeps D1 &lt;500MB while serving 7-day graphs without scanning thousands of raw rows.</li>
          <li>Frontend uses hourly aggregates for 7-day charts; LIVE values from recent raw.</li>
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Uptime / downtime / incidents</h2>
        <p className="text-sm">Allowed statuses: SUCCESS/TIMEOUT/RATE_LIMITED/PROVIDER_ERROR/MODEL_UNAVAILABLE/STREAM_ERROR/UNKNOWN_ERROR. Outage starts after 3 consecutive failures, ends on first SUCCESS. Stores started_at, ended_at, duration. We expose uptime_24h/7d, downtime, incident_count, longest_outage. Single transient failure does not count as long outage.</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Scoring</h2>
        <pre className="mono text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3">score = 0.40*tps_score + 0.25*ttft_score + 0.25*reliability_score + 0.10*consistency_score</pre>
        <p className="text-sm">Normalized across currently active FREE models. Profiles: Balanced (default), Fastest (0.6 TPS), Lowest Latency (0.5 TTFT), Most Reliable (0.55 reliability), Coding (0.35/0.15/0.30/0.20). No LLM calculates scores.</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Limitations</h2>
        <p className="text-sm text-zinc-400">Measurements influenced by: provider load, network location/routing, time of day, model version drift, streaming behavior, request size, benchmark prompt. Workers Cron/Queue bounded execution windows mean benchmark jobs are short, retryable, distributed — not one long worker. Hourly aggregates use local percentiles; server vs user time is UTC internally, display converts to user TZ.</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">API & deployment</h2>
        <pre className="mono text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3">GET /api/providers
GET /api/models?provider=&includeInactive=
GET /api/leaderboard?range=1h|24h|3d|7d&provider=&benchmark=&sort=&profile=
GET /api/models/:id/history?range=
GET /api/models/:id/incidents
GET /api/compare?models=1,2
GET /api/live  (SSE via Durable Object)
GET /api/cooldowns
GET /api/health?freshness=15   → 503 when data older than N min (uptime-monitor probe)
POST /api/admin/{`discover|benchmark|reaggregate|cleanup|migrate|cooldown/reset`}  (ADMIN_TOKEN)
wrangler d1 migrations apply DB --local / --remote
wrangler secret put OPENCODE_API_KEY OPENROUTER_API_KEY ADMIN_TOKEN</pre>
        <p className="text-sm">See README + wrangler.jsonc for D1/Queue/DO/Cron binding docs.</p>
      </section>
    </div>
  );
}
