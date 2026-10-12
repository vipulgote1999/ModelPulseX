export default function Vs() {
  const rows: Array<[string, string, string, string]> = [
    [
      "ModelPulseX (this site)",
      "Live tokens/sec, time-to-first-token and 24h/7d reliability across 21 free providers (OpenCode Zen, OpenCode Go, Ollama Free/Pro, OpenRouter and 17 more).",
      "Continuous: every-5-minute tick plus per-tier cadence (Pro ~10m, Free/Zen ~60m, Go ~30m).",
      "Live serving speed on free endpoints, right now.",
    ],
    [
      "TokenDyno",
      "Live tokens/sec, time-to-first-token and 24h reliability across Ollama, OpenCode Zen and OpenCode Go endpoints.",
      "Continuous: Ollama Pro ~10m, capped plans ~60m, Go ~30m.",
      "Live serving speed on those three providers. Our methodology matches theirs; our intelligence data cites them (CC-BY 4.0).",
    ],
    [
      "Artificial Analysis",
      "Capability (Intelligence Index), output speed, price and latency in one comparison.",
      "Intelligence Index per model release; performance on a recurring schedule.",
      "Comparing the capability-speed-price tradeoff in one view. We link every score to its AA model page.",
    ],
    [
      "LiveBench",
      "Contamination-free capability across task categories (reasoning, coding, math and more).",
      "Question rotation monthly; full refresh about every 6 months.",
      "A clean, contamination-resistant capability signal. Capability-only: it does not measure speed.",
    ],
  ];
  return (
    <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 space-y-6 text-zinc-300 leading-relaxed">
      <div>
        <h1 className="text-2xl font-bold text-white">ModelPulseX vs others</h1>
        <p className="text-sm text-zinc-400 mt-1">
          These tools measure different things and are complementary, not competing.
        </p>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] tracking-widest text-zinc-500 border-b border-zinc-800">
              <tr>
                <th className="text-left px-4 py-2">Tool</th>
                <th className="text-left px-2 py-2">What it measures</th>
                <th className="text-left px-2 py-2 hidden md:table-cell">Refresh cadence</th>
                <th className="text-left px-4 py-2 hidden lg:table-cell">Best for</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([tool, measures, cadence, best]) => (
                <tr key={tool} className="border-b border-zinc-800/60 align-top">
                  <td className="px-4 py-3 font-medium text-zinc-100 whitespace-nowrap">{tool}</td>
                  <td className="px-2 py-3 text-zinc-300">{measures}</td>
                  <td className="px-2 py-3 text-zinc-400 hidden md:table-cell">{cadence}</td>
                  <td className="px-4 py-3 text-zinc-400 hidden lg:table-cell">{best}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <h2 className="font-semibold text-white">Frequently asked questions</h2>
        <div className="text-sm space-y-3">
          <div>
            <p className="font-medium text-zinc-100">How is ModelPulseX different from TokenDyno?</p>
            <p>Both track live speed continuously with comparable methods. ModelPulseX covers 21 free
              providers instead of three, keeps 7-day windows instead of 24-hour ones, adds coding probes
              next to the speed probe, and scores models on balanced profiles instead of raw TPS order.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-100">How is ModelPulseX different from Artificial Analysis?</p>
            <p>Artificial Analysis measures capability, speed and price together on a recurring schedule.
              ModelPulseX re-benchmarks free endpoints continuously and does not score capability itself —
              it displays the Intelligence Index sourced from Artificial Analysis next to its own speed data.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-100">How is ModelPulseX different from LiveBench?</p>
            <p>LiveBench is capability-only: it does not measure inference speed, cost, or endpoints.
              ModelPulseX is a speed-and-reliability tracker and runs no capability test of its own.</p>
          </div>
          <div>
            <p className="font-medium text-zinc-100">Is ModelPulseX affiliated with any provider?</p>
            <p>No. ModelPulseX is not affiliated with any benchmarked provider and receives no payment
              for ranking or placement. Every number is generated automatically on a fixed schedule.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
