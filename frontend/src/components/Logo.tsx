import { useId } from "react";

type LogoVariant = "mark" | "full" | "mono";

// v3 geometry (32-grid — AI round-4 solid mark, orbit restored):
// thick solid X arm + pulse arm (straight diagonal, one first-token spike
// weaving through the solid arm like a signal crossing a baseline),
// thin dashed orbit ring. Flat tile, no glow — wordmark stays code-rendered.
//
// The arms are SOLID FILLED outlines, not strokes: each `d` is the exact stroke
// outline of that arm's centreline at its v3 weight (4.2 / 3.6), with round caps
// and round joins. Filling means the mark is plain geometry rather than something
// a renderer has to paint, and — together with the userSpaceOnUse gradient in the
// svg below — both arms share one colour field, so where they cross there is no
// seam, gap, or cutout.
const PULSE_ARM =
  "M8.827 23.716 L14.327 17.716 A1.8 1.8 0 0 0 14.671 17.169 L14.846 16.731 L15.292 18.069 A1.8 1.8 0 0 0 18.313 18.731 L25.813 10.731 A1.8 1.8 0 0 0 23.187 8.269 L17.753 14.065 L16.708 10.931 A1.8 1.8 0 0 0 13.329 10.831 L11.451 15.526 L6.173 21.284 A1.8 1.8 0 0 0 8.827 23.716 Z";
const CROSS_ARM =
  "M8.015 10.985 L21.015 23.985 A2.1 2.1 0 0 0 23.985 21.015 L10.985 8.015 A2.1 2.1 0 0 0 8.015 10.985 Z";

function MarkPaths({ fill }: { fill: string }) {
  return (
    // Scaled ~1.1x about center — round-4 airy padding so thick strokes clear the tile
    <g transform="translate(16,16) scale(1.1) translate(-16,-16)">
      <circle
        cx="16"
        cy="16"
        r="10.5"
        fill="none"
        stroke={fill}
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.55"
        strokeDasharray="56 10"
        transform="rotate(53 16 16)"
      />
      <path d={CROSS_ARM} fill={fill} />
      <path d={PULSE_ARM} fill={fill} />
    </g>
  );
}

export default function Logo({
  variant = "mark",
  size = 36,
  withTile = true,
  className = "",
  label = "ModelPulseX home",
}: {
  variant?: LogoVariant;
  size?: number;
  withTile?: boolean;
  className?: string;
  label?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradId = `mpx-g-${uid}`;
  const gradient = `url(#${gradId})`;

  const mark = (tile: boolean, s: number, mono: string | null) => (
    <svg
      width={s}
      height={s}
      viewBox="0 0 32 32"
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      <defs>
        {/* userSpaceOnUse spanning the orbit ring's own extent: the ring is
            pixel-identical to the old objectBoundingBox mapping, but both arms
            now read the SAME colour field, so the crossing has no seam. */}
        <linearGradient
          id={gradId}
          gradientUnits="userSpaceOnUse"
          x1="5.5"
          y1="5.5"
          x2="26.5"
          y2="26.5"
        >
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      {tile && (
        <rect
          x="0.5"
          y="0.5"
          width="31"
          height="31"
          rx="7.5"
          fill="#0B0B12"
          stroke={mono ?? "#8B5CF6"}
          strokeOpacity={0.35}
          strokeWidth="1"
        />
      )}
      <MarkPaths fill={mono ?? gradient} />
    </svg>
  );

  if (variant === "mark")
    return <span className={className}>{mark(withTile, size, null)}</span>;

  if (variant === "mono")
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        {mark(false, size, "currentColor")}
        <span className="font-semibold tracking-tight leading-none text-[15px]">
          ModelPulseX
        </span>
      </span>
    );

  // full lockup: mark tile + wordmark + descriptor
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      {mark(true, size, null)}
      <span className="leading-none">
        <span className="block font-semibold tracking-tight text-[15px]">
          ModelPulse
          <span className="bg-gradient-to-r from-violet-400 to-cyan-300 bg-clip-text text-transparent">
            X
          </span>
        </span>
        <span className="mt-1 block text-[10px] font-medium tracking-[0.18em] text-zinc-400">
          LLM PERFORMANCE OBSERVATORY
        </span>
      </span>
    </span>
  );
}
