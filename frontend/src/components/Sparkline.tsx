export default function Sparkline({ points, width = 120, height = 28 }: { points: Array<number | null>; width?: number; height?: number }) {
  const vals = points.filter((v): v is number => v != null);
  if (vals.length < 2) return <span className="text-[11px] text-zinc-600">—</span>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  let d = "";
  points.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    d += i === 0 || points[i - 1] == null ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
  });
  // color by trend: up green, down amber, flat zinc
  const first = vals[0]!, last = vals[vals.length - 1]!;
  const color = last > first * 1.05 ? "#10b981" : last < first * 0.95 ? "#f59e0b" : "#8b5cf6";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      {/* last dot */}
      <circle cx={width} cy={height - ((last - min) / range) * (height - 4) - 2} r={2} fill={color} />
    </svg>
  );
}
