import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'atoms:theme';
const QUERY = '(prefers-color-scheme: dark)';

function subscribeSystem(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

function systemDark() {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
}

function readMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const saved = window.localStorage.getItem(KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

/**
 * 主题：三态（system / light / dark）。
 * 只切换 <html> 上的 .dark 与 color-scheme —— CSS 端用 `.dark` 变体，无需 media query。
 * 首屏防闪由 index.html 的内联脚本完成（在 React 挂载前先落类名）。
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const sysDark = useSyncExternalStore(subscribeSystem, systemDark, () => false);
  const dark = mode === 'dark' || (mode === 'system' && sysDark);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);

  const setMode = useCallback((next: ThemeMode) => {
    window.localStorage.setItem(KEY, next);
    setModeState(next);
  }, []);

  return { mode, dark, setMode };
}

export const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
];
