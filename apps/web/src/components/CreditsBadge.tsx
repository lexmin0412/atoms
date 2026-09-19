import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type CreditSummary } from '../lib/api';

/** 顶栏积分：剩余 / 本周期额度（1 积分 = $0.01） */
export default function CreditsBadge({ refreshKey = 0 }: { refreshKey?: number }) {
  const [c, setC] = useState<CreditSummary | null>(null);

  useEffect(() => {
    api
      .credits()
      .then(setC)
      .catch(() => {});
  }, [refreshKey]);

  if (!c) return null;

  const pct = c.monthlyGrant > 0 ? (c.balance / c.monthlyGrant) * 100 : 0;
  const tone =
    c.balance <= 0
      ? 'text-red-500'
      : pct <= 15
        ? 'text-amber-500'
        : 'text-neutral-500 dark:text-neutral-400';

  return (
    <Link
      to="/credits"
      title={`本月已用 ${c.spent.toFixed(2)} 积分（${c.period}，每月补满到 ${c.monthlyGrant}）`}
      className={
        'flex items-center gap-1.5 rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
        tone
      }
    >
      <span>积分</span>
      <span className="font-medium tabular-nums">{c.balance.toFixed(2)}</span>
      <span className="text-neutral-400">/ {c.monthlyGrant}</span>
    </Link>
  );
}
