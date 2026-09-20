import type { ProjectDto, UserDto } from '@atoms/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { api } from '../lib/api';
import { cx } from '../lib/cx';
import { ThemeCycle, ThemeToggle } from './ThemeToggle';
import { AtomsLogo, AtomsMark } from './ui/Logo';

const COLLAPSE_KEY = 'atoms:nav-collapsed';

function Icon({ name, size = 15 }: { name: string; size?: number }) {
  const c = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...c}>
          <path d="M3 10.2 12 3l9 7.2" />
          <path d="M5 9.5V20h14V9.5" />
        </svg>
      );
    case 'credits':
      return (
        <svg {...c}>
          <ellipse cx="12" cy="6.5" rx="8" ry="3" />
          <path d="M4 6.5v11c0 1.7 3.6 3 8 3s8-1.3 8-3v-11" />
          <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        </svg>
      );
    case 'skills':
      return (
        <svg {...c}>
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
          <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
        </svg>
      );
    case 'menu':
      return (
        <svg {...c}>
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      );
    case 'back':
      return (
        <svg {...c}>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      );
    case 'panel':
      return (
        <svg {...c}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M10 4v16" />
        </svg>
      );
    default:
      return null;
  }
}

function UserBox({
  user,
  onLogout,
  compact = false,
}: {
  user: UserDto;
  onLogout: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={compact ? user.username : undefined}
        className={
          'hover:bg-muted flex w-full items-center gap-2.5 rounded-md transition-colors ' +
          (compact ? 'justify-center px-0 py-2' : 'px-2 py-2')
        }
      >
        <span className="bg-accent-soft text-accent-ink grid size-7 shrink-0 place-items-center rounded-sm text-[12px] font-semibold">
          {(user.username || user.email).slice(0, 1).toUpperCase()}
        </span>
        {!compact && (
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[13px] font-medium">
              {user.username}
            </span>
            <span className="text-muted-foreground block truncate text-[11.5px]">
              {user.email}
            </span>
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className={
            'panel-raised absolute bottom-full z-50 mb-1.5 p-1.5 ' +
            (compact ? 'left-full ml-1.5 w-40' : 'left-0 w-full')
          }
        >
          <button
            role="menuitem"
            onClick={onLogout}
            className="text-muted-foreground hover:bg-muted hover:text-foreground block w-full rounded-xs px-2 py-1.5 text-left text-[12.5px] transition-colors"
          >
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

const NAV = [
  { to: '/', label: '首页', icon: 'home' },
  { to: '/skills', label: '技能', icon: 'skills' },
  { to: '/credits', label: '积分', icon: 'credits' },
];

/**
 * 应用外壳：左侧导航 + 主区。导航可折叠（持久化）。
 * 工作台等需要全高的页面用 bare 关闭主区滚动。
 */
export function AppShell({
  user,
  onLogout,
  bare = false,
  children,
}: {
  user: UserDto;
  onLogout: () => void;
  bare?: boolean;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== 'undefined' && window.localStorage.getItem(COLLAPSE_KEY) === '1',
  );
  const [recent, setRecent] = useState<ProjectDto[]>([]);
  /** 移动端：导航以抽屉形式覆盖显示 */
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    api
      .listProjects()
      .then((r) => setRecent(r.projects.slice(0, 6)))
      .catch(() => {});
  }, [pathname]);

  function toggleCollapse() {
    setCollapsed((v) => {
      window.localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
      return !v;
    });
  }

  // 抽屉打开时按完整形态渲染（折叠是桌面端的概念）
  const compact = collapsed && !drawerOpen;
  const activeProjectId = pathname.startsWith('/p/') ? pathname.slice(3) : '';
  const isActive = (to: string) =>
    to === '/' ? pathname === '/' || pathname.startsWith('/p/') : pathname.startsWith(to);

  return (
    <div
      className="group/shell bg-background flex h-full overflow-hidden"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ ['--nav-overlay' as string]: collapsed ? '44px' : '0px' }}
    >
      {/* 移动端抽屉遮罩 */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 sm:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={cx(
          'border-border bg-surface flex shrink-0 flex-col border-r',
          // 移动端：抽屉（覆盖式）；桌面端：静态列（可折叠）
          'fixed inset-y-0 left-0 z-50 w-64 transition-transform duration-200',
          // ≥640 恢复桌面布局：静态列、始终可见
          'sm:visible sm:static sm:z-auto sm:translate-x-0 sm:transition-[width] sm:duration-150',
          // 窄屏关闭时用 invisible：translate 只是视觉位移，链接仍会被读屏/键盘 focus 到
          drawerOpen ? 'visible translate-x-0' : 'invisible -translate-x-full',
          collapsed ? 'sm:w-16' : 'sm:w-64',
        )}
      >
        <div
          className={cx(
            'flex h-12 shrink-0 items-center',
            collapsed ? 'justify-center gap-1 px-1.5' : 'px-3',
          )}
        >
          {collapsed ? (
            <Link to="/" aria-label="Atoms 首页" style={{ color: 'var(--accent-ink)' }}>
              <AtomsMark size={18} />
            </Link>
          ) : (
            <>
              <Link to="/" className="rounded-xs" aria-label="Atoms 首页">
                <AtomsLogo />
              </Link>
              <button
                onClick={toggleCollapse}
                aria-label="收起侧栏"
                title="收起侧栏"
                className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto hidden size-7 place-items-center rounded-xs transition-colors sm:grid"
              >
                <Icon name="panel" />
              </button>
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭导航"
                title="关闭导航"
                className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto grid size-9 place-items-center rounded-xs transition-colors sm:hidden"
              >
                <Icon name="back" />
              </button>
            </>
          )}
        </div>

        {!compact && (
          <div className="px-3 pb-1">
            <div className="border-border bg-muted/40 flex items-center gap-2.5 rounded-md border px-2.5 py-2">
              <span className="bg-accent-soft text-accent-ink grid size-6 shrink-0 place-items-center rounded-xs text-[11px] font-semibold">
                个
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">个人空间</span>
                <span className="text-muted-foreground block truncate text-[11px]">
                  {user.username} 的项目
                </span>
              </span>
            </div>
          </div>
        )}

        <nav className={cx('flex flex-col gap-0.5 py-2', compact ? 'px-2' : 'px-3')}>
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={compact ? n.label : undefined}
              onClick={() => setDrawerOpen(false)}
              className={cx(
                'flex items-center gap-2.5 rounded-md text-[13px] transition-colors',
                compact ? 'justify-center px-0 py-2.5 sm:py-2' : 'px-2.5 py-2.5 sm:py-2',
                isActive(n.to)
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <span style={isActive(n.to) ? { color: 'var(--accent-ink)' } : undefined}>
                <Icon name={n.icon} />
              </span>
              {!compact && n.label}
            </Link>
          ))}
        </nav>

        {!compact && recent.length > 0 && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
            <p className="text-muted-foreground/80 px-2.5 pb-1.5 text-[11px] tracking-wide">
              最近
            </p>
            <div className="flex flex-col gap-0.5">
              {recent.map((p) => (
                <Link
                  key={p.id}
                  to={`/p/${p.id}`}
                  onClick={() => setDrawerOpen(false)}
                  title={p.title}
                  className={cx(
                    'truncate rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors',
                    activeProjectId === p.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {p.title}
                </Link>
              ))}
            </div>
          </div>
        )}
        {(!compact && recent.length === 0) || compact ? <div className="flex-1" /> : null}

        <div
          className={cx(
            'border-border mt-auto border-t py-2.5',
            'pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:pb-2.5',
            compact ? 'px-2' : 'px-3',
          )}
        >
          <div className={cx('mb-2 flex', compact ? 'justify-center' : 'px-1')}>
            {compact ? <ThemeCycle /> : <ThemeToggle />}
          </div>
          <UserBox user={user} onLogout={onLogout} compact={compact} />
        </div>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {collapsed && (
          <button
            onClick={toggleCollapse}
            aria-label="展开侧栏"
            title="展开侧栏"
            className="panel text-muted-foreground hover:text-foreground absolute top-2.5 left-2.5 z-30 hidden size-7 place-items-center transition-colors sm:grid"
          >
            <Icon name="panel" />
          </button>
        )}

        {bare ? (
          <>
            {/* 工作台自带头部：移动端放一个浮动入口，页面头部用 pl-11 让位 */}
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="打开导航"
              className="panel text-muted-foreground hover:text-foreground absolute top-1.5 left-2 z-30 grid size-9 place-items-center transition-colors sm:hidden"
            >
              <Icon name="menu" />
            </button>
            <div className="min-h-0 min-w-0 flex-1">{children}</div>
          </>
        ) : (
          <>
            {/* 移动端顶部条：汉堡 + 品牌 */}
            <header className="border-border bg-surface flex h-12 shrink-0 items-center gap-2.5 border-b px-3 sm:hidden">
              <button
                onClick={() => setDrawerOpen(true)}
                aria-label="打开导航"
                className="text-muted-foreground hover:text-foreground -ml-1 grid size-9 place-items-center rounded-xs transition-colors"
              >
                <Icon name="menu" />
              </button>
              <Link to="/" aria-label="Atoms 首页">
                <AtomsLogo />
              </Link>
            </header>
            <main
              className="min-h-0 w-full flex-1 overflow-y-auto"
              style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              {children}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
