import { useId } from "react";

type LogoVariant = "mark" | "full" | "mono";

// v3 geometry (32-grid — AI round-4 solid mark, orbit restored):
// thick solid X arm + pulse arm (straight diagonal, one sharp first-token
// spike weaving through the solid arm like a signal crossing a baseline),
// thin dashed orbit ring. Flat tile, no glow — wordmark stays code-rendered.
const PULSE_ARM = "M7.5 22.5 L13 16.5 L15 11.5 L17 17.5 L24.5 9.5";
const CROSS_ARM = "M9.5 9.5 L22.5 22.5";

function MarkPaths({ stroke }: { stroke: string }) {
  return (
    // Scaled ~1.1x about center — round-4 airy padding so thick strokes clear the tile
    <g transform="translate(16,16) scale(1.1) translate(-16,-16)">
      <circle
        cx="16"
        cy="16"
        r="10.5"
        fill="none"
        stroke={stroke}
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.55"
        strokeDasharray="56 10"
        transform="rotate(53 16 16)"
      />
      <path
        d={CROSS_ARM}
        fill="none"
        stroke={stroke}
        strokeWidth="4.2"
        strokeLinecap="round"
      />
      <path
        d={PULSE_ARM}
        fill="none"
        stroke={stroke}
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
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
      <MarkPaths stroke={mono ?? gradient} />
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
