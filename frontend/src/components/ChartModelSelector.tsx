import { getAA } from "../lib/intelligence";

type Row = {
  model_id: number;
  model: string;
  display_name: string;
  provider: string;
  tps_now: number | null;
  overall_score?: number | null;
};

export default function ChartModelSelector({
  rows,
  selected,
  onChange,
}: {
  rows: Row[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  // rank rows by intelligence desc, then overall_score desc for display order in dropdowns
  const sortedByIntel = [...rows].sort((a, b) => {
    const aa = getAA(a.model)?.score ?? -1;
    const bb = getAA(b.model)?.score ?? -1;
    if (aa !== bb) return bb - aa;
    return (b.overall_score ?? -1) - (a.overall_score ?? -1);
  });

  const updateSlot = (slot: number, value: string) => {
    const v = Number(value);
    let next = [...selected];
    // ensure length 3 with pads
    while (next.length < 3) next.push(0 as unknown as number);
    if (!value || Number.isNaN(v) || v === 0) {
      // clear slot
      next[slot] = 0 as unknown as number;
    } else {
      // prevent duplicate: if already selected elsewhere, swap or ignore
      if (next.includes(v) && next[slot] !== v) {
        // if duplicate, don't add—just keep previous
        return;
      }
      next[slot] = v;
    }
    // compact: remove 0s and keep order, max 3
    const compact = next.filter((x) => x !== 0).slice(0, 3);
    onChange(compact);
  };

  const addSlot = () => {
    if (selected.length >= 3) return;
    // pick next best intelligence not yet selected
    const candidate = sortedByIntel.find((r) => !selected.includes(r.model_id));
    if (candidate) onChange([...selected, candidate.model_id].slice(0, 3));
  };

  const removeSlot = (idx: number) => {
    const next = selected.filter((_, i) => i !== idx);
    onChange(next);
  };

  const clear = () => onChange([]);

  // pad slots to 3 for UI
  const slots: Array<number | ""> = [selected[0] ?? "", selected[1] ?? "", selected[2] ?? ""];

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold">Graph comparison — pick up to 3 models</div>
        <div className="text-[11px] text-zinc-500">
          Default: highest Intelligence (Artificial Analysis) · max 3 · affects all graphs below
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[0, 1, 2].map((slot) => (
          <div key={slot} className="flex gap-2 items-center">
            <span className="text-xs font-mono text-zinc-500 w-6">{slot + 1}.</span>
            <select
              value={slots[slot] === "" ? "" : String(slots[slot])}
              onChange={(e) => updateSlot(slot, e.target.value)}
              className="flex-1 rounded-md bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="">— None —</option>
              {sortedByIntel.map((r) => {
                const aa = getAA(r.model);
                const scoreTxt = aa ? ` ★${aa.score.toFixed(1)}` : "";
                const tpsTxt = r.tps_now != null ? ` · ${r.tps_now.toFixed(1)} TPS` : "";
                const disabled = selected.includes(r.model_id) && selected[slot] !== r.model_id;
                return (
                  <option key={r.model_id} value={String(r.model_id)} disabled={disabled}>
                    {r.display_name} · {r.provider}
                    {scoreTxt}
                    {tpsTxt}
                  </option>
                );
              })}
            </select>
            {selected[slot] != null && String(slots[slot]) !== "" && (
              <button
                onClick={() => removeSlot(slot)}
                className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white"
                title="Remove"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {selected.length < 3 && (
          <button
            onClick={addSlot}
            className="text-xs px-3 py-1.5 rounded bg-violet-900/40 border border-violet-800 text-violet-200 hover:bg-violet-900/60"
          >
            + Add next best (Intelligence)
          </button>
        )}
        {selected.length > 0 && (
          <button
            onClick={clear}
            className="text-xs px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white"
          >
            Clear
          </button>
        )}
        <span className="text-[11px] text-zinc-500 ml-auto">
          {selected.length === 0
            ? "No models selected → charts show top 3 by Intelligence automatically"
            : `${selected.length}/3 selected · click leaderboard rows also toggles (max 3)`}
        </span>
      </div>
    </div>
  );
}
