/**
 * 文件类型图标：文档轮廓 + 按类型着色（对齐 VSCode 的观感，但不引入图标包）。
 * 颜色挑的是明暗两套主题下都能看清的中低饱和色。
 */

const COLORS: Record<string, string> = {
  ts: '#3b82f6',
  tsx: '#38bdf8',
  js: '#eab308',
  jsx: '#eab308',
  mjs: '#eab308',
  cjs: '#eab308',
  json: '#f59e0b',
  css: '#a855f7',
  scss: '#a855f7',
  html: '#ef4444',
  htm: '#ef4444',
  md: '#94a3b8',
  markdown: '#94a3b8',
  yaml: '#94a3b8',
  yml: '#94a3b8',
  lock: '#94a3b8',
  svg: '#f97316',
  png: '#f97316',
  jpg: '#f97316',
  gitignore: '#94a3b8',
};

function extOf(name: string): string {
  if (name.startsWith('.') && !name.slice(1).includes('.')) return name.slice(1);
  const parts = name.split('.');
  return parts.length > 1 ? (parts.pop() as string).toLowerCase() : '';
}

function Doc({ color }: { color: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 2.5h7.2L19 8.3V21a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M13 2.8V8.5h5.6" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function FileIcon({ name }: { name: string }) {
  const color = COLORS[extOf(name)] ?? 'var(--muted-foreground)';
  return <Doc color={color} />;
}

export function FolderIcon({ open = false }: { open?: boolean }) {
  const color = 'var(--muted-foreground)';
  return open ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 1.8h8.4A1.5 1.5 0 0 1 20 9.3V10H6.2a2 2 0 0 0-1.9 1.4L3 16.5V7.5Z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M6.2 11h13.1a1 1 0 0 1 .96 1.3l-1.4 4.9A1.5 1.5 0 0 1 17.4 18H4.3a1 1 0 0 1-.96-1.3l1.4-4.9A1.5 1.5 0 0 1 6.2 11Z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4L10.1 7.5H18a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 18.5H4.5A1.5 1.5 0 0 1 3 17V7Z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
