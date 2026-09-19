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

  const activeProjectId = pathname.startsWith('/p/') ? pathname.slice(3) : '';
  const isActive = (to: string) =>
    to === '/' ? pathname === '/' || pathname.startsWith('/p/') : pathname.startsWith(to);

  return (
    <div
      className="group/shell bg-background flex h-full overflow-hidden"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ ['--nav-overlay' as string]: collapsed ? '44px' : '0px' }}
    >
      <aside
        className={cx(
          'flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150',
          collapsed ? 'w-16' : 'w-64',
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
                className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto grid size-7 place-items-center rounded-xs transition-colors"
              >
                <Icon name="panel" />
              </button>
            </>
          )}
        </div>

        {!collapsed && (
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

        <nav className={cx('flex flex-col gap-0.5 py-2', collapsed ? 'px-2' : 'px-3')}>
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={collapsed ? n.label : undefined}
              className={cx(
                'flex items-center gap-2.5 rounded-md text-[13px] transition-colors',
                collapsed ? 'justify-center px-0 py-2' : 'px-2.5 py-2',
                isActive(n.to)
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <span style={isActive(n.to) ? { color: 'var(--accent-ink)' } : undefined}>
                <Icon name={n.icon} />
              </span>
              {!collapsed && n.label}
            </Link>
          ))}
        </nav>

        {!collapsed && recent.length > 0 && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
            <p className="text-muted-foreground/80 px-2.5 pb-1.5 text-[11px] tracking-wide">
              最近
            </p>
            <div className="flex flex-col gap-0.5">
              {recent.map((p) => (
                <Link
                  key={p.id}
                  to={`/p/${p.id}`}
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
        {(!collapsed && recent.length === 0) || collapsed ? (
          <div className="flex-1" />
        ) : null}

        <div
          className={cx(
            'mt-auto border-t border-border py-2.5',
            collapsed ? 'px-2' : 'px-3',
          )}
        >
          <div className={cx('mb-2 flex', collapsed ? 'justify-center' : 'px-1')}>
            {collapsed ? <ThemeCycle /> : <ThemeToggle />}
          </div>
          <UserBox user={user} onLogout={onLogout} compact={collapsed} />
        </div>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {collapsed && (
          <button
            onClick={toggleCollapse}
            aria-label="展开侧栏"
            title="展开侧栏"
            className="panel text-muted-foreground hover:text-foreground absolute top-2.5 left-2.5 z-30 hidden size-7 place-items-center transition-colors lg:grid"
          >
            <Icon name="panel" />
          </button>
        )}
        {bare ? (
          <div className="min-h-0 min-w-0 flex-1">{children}</div>
        ) : (
          <main className="min-h-0 w-full flex-1 overflow-y-auto">{children}</main>
        )}
      </div>
    </div>
  );
}
