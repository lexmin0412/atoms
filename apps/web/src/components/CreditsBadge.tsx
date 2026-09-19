import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type CreditSummary } from '../lib/api';
import { cx } from '../lib/cx';

/**
 * 顶栏积分：图标 + 余额；点击弹出 Popover（不直接跳转），
 * 明细入口在 Popover 里。
 */
export default function CreditsBadge({ refreshKey = 0 }: { refreshKey?: number }) {
  const [c, setC] = useState<CreditSummary | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .credits()
        .then((r) => {
          if (alive) setC(r);
        })
        .catch(() => {});
    };
    load();
    // 生成结束后由工作台广播，避免跨层传递刷新信号
    window.addEventListener('atoms:credits', load);
    return () => {
      alive = false;
      window.removeEventListener('atoms:credits', load);
    };
  }, [refreshKey]);

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

  if (!c) return null;

  const pct = c.monthlyGrant > 0 ? (c.balance / c.monthlyGrant) * 100 : 0;
  const tone = c.balance <= 0 ? 'text-danger' : pct <= 15 ? 'text-warn' : '';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="积分"
        className={cx(
          'text-foreground inline-flex items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-[12px] transition-colors',
          'hover:border-border-strong hover:bg-muted',
          tone,
        )}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          style={{ color: 'var(--accent-ink)' }}
          aria-hidden
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5v9M9.5 10h5M9.5 14h5" />
        </svg>
        <span className="tnum font-medium">{c.balance.toFixed(2)}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="积分"
          className="panel-raised absolute right-0 z-50 mt-1.5 w-56 p-3"
        >
          <p className="text-muted-foreground text-[11.5px]">积分余额</p>
          <p className="tnum mt-1 text-[20px] leading-none font-semibold">
            {c.balance.toFixed(2)}
          </p>
          <p className="tnum text-muted-foreground mt-2 text-[11.5px]">
            本周期已用 {c.spent.toFixed(2)} · 每月补满 {c.monthlyGrant}
          </p>
          <div className="bg-border my-2.5 h-px" />
          <Link
            to="/credits"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground block text-[12.5px] transition-colors"
          >
            查看积分明细 →
          </Link>
        </div>
      )}
    </div>
  );
}
