import { cx } from '../lib/cx';
import { THEME_OPTIONS, useTheme, type ThemeMode } from '../lib/theme';

function Icon({ mode }: { mode: ThemeMode }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (mode === 'light')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </svg>
    );
  if (mode === 'dark')
    return (
      <svg {...common}>
        <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 20h8" />
    </svg>
  );
}

/** 三态主题切换：跟随系统 / 亮 / 暗 */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="group"
      aria-label="主题"
      className="border-border inline-flex items-center gap-0.5 rounded-sm border p-0.5"
    >
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.value}
          onClick={() => setMode(o.value)}
          title={o.label}
          aria-label={o.label}
          aria-pressed={mode === o.value}
          className={cx(
            'grid size-6 place-items-center rounded-xs transition-colors',
            mode === o.value
              ? 'bg-accent/12 text-accent'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Icon mode={o.value} />
        </button>
      ))}
    </div>
  );
}

/** 折叠侧栏时的紧凑版：单键循环 系统 → 亮 → 暗 */
export function ThemeCycle() {
  const { mode, setMode } = useTheme();
  const next: ThemeMode =
    mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
  const label = mode === 'system' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色';
  return (
    <button
      onClick={() => setMode(next)}
      title={`主题：${label}（点击切换）`}
      aria-label={`主题：${label}`}
      className="text-muted-foreground hover:bg-muted hover:text-foreground grid size-7 place-items-center rounded-xs transition-colors"
    >
      <Icon mode={mode} />
    </button>
  );
}
