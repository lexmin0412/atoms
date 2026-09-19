/**
 * 品牌标识：点阵 / 原子。
 * 网格点阵 + 中心核 + 一道轨道 —— 与蓝图网格背景同构，表达「小单元 → 结构」。
 */

export function AtomsMark({ size = 20 }: { size?: number }) {
  const dots = [
    [4, 4],
    [12, 4],
    [20, 4],
    [4, 12],
    [20, 12],
    [4, 20],
    [12, 20],
    [20, 20],
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      {/* 轨道 */}
      <ellipse
        cx="12"
        cy="12"
        rx="10.5"
        ry="4.5"
        transform="rotate(-32 12 12)"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.5"
      />
      {/* 点阵 */}
      {dots.map(([x, y]) => (
        <circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r="1.35"
          fill="currentColor"
          opacity="0.42"
        />
      ))}
      {/* 核 */}
      <circle cx="12" cy="12" r="2.7" fill="currentColor" />
    </svg>
  );
}

export function AtomsLogo({ size = 20 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <span style={{ color: 'var(--accent)' }}>
        <AtomsMark size={size} />
      </span>
      <span
        className="text-[15px] leading-none font-semibold tracking-[-0.02em]"
        style={{ color: 'var(--foreground)' }}
      >
        Atoms
      </span>
    </span>
  );
}
