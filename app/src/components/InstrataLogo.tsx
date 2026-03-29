export function InstrataLogo({ size = 36 }: { size?: number }) {
  const s = size;
  const half = s / 2;
  const r = s * 0.35;
  const sq = s * 0.48;
  const strokeW = s * 0.06;

  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Top-left navy circle */}
      <circle cx={half * 0.72} cy={half * 0.72} r={r} stroke="#22326E" strokeWidth={strokeW} fill="none" />
      {/* Bottom-right navy circle */}
      <circle cx={half * 1.28} cy={half * 1.28} r={r} stroke="#22326E" strokeWidth={strokeW} fill="none" />
      {/* Top-right orange square */}
      <rect
        x={half * 1.28 - sq / 2}
        y={half * 0.72 - sq / 2}
        width={sq}
        height={sq}
        stroke="#F68D2E"
        strokeWidth={strokeW}
        fill="none"
        rx={sq * 0.08}
      />
      {/* Bottom-left orange square */}
      <rect
        x={half * 0.72 - sq / 2}
        y={half * 1.28 - sq / 2}
        width={sq}
        height={sq}
        stroke="#F68D2E"
        strokeWidth={strokeW}
        fill="none"
        rx={sq * 0.08}
      />
    </svg>
  );
}
