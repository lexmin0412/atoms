/**
 * 通用图标集（内联 SVG，stroke=currentColor）。
 * 只放界面真正用到的，避免引入图标包。
 */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function Svg({ size = 15, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} {...base}>
      {children}
    </svg>
  );
}

export function IconPlus({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconRocket({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M13.5 4.5c2.7-2 6-2 6-2s0 3.3-2 6l-3.2 4.3a3 3 0 0 1-1.2 1l-2.4 1-1-1-1-1 1-2.4a3 3 0 0 1 1-1.2L13.5 4.5Z" />
      <path d="M9 15c-1.4.4-2.2 2.7-2.2 2.7S9.1 18.4 9.5 17M14.5 9.5h.01" />
    </Svg>
  );
}

export function IconArrowRight({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M5 12h13M13 6l6 6-6 6" />
    </Svg>
  );
}

export function IconFilePlus({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 2.5h7.2L19 8.3V21a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
      <path d="M13 2.8V8.5h5.6" />
      <path d="M12 12v6M9 15h6" />
    </Svg>
  );
}

export function IconFolderPlus({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4L10.1 7.5H18a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 18.5H4.5A1.5 1.5 0 0 1 3 17V7Z" />
      <path d="M10.5 12.5h5M13 10v5" />
    </Svg>
  );
}

export function IconCopy({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 6.5A1.5 1.5 0 0 0 13.5 5h-8A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16" />
    </Svg>
  );
}

export function IconRefresh({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7" />
      <path d="M4 5v6h6" />
    </Svg>
  );
}

export function IconSparkle({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9 12 3.5Z" />
    </Svg>
  );
}

export function IconTable({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M9.5 9.5v10" />
    </Svg>
  );
}
