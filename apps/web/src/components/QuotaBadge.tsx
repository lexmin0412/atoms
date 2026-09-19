import { useEffect, useState } from 'react';

import { api } from '../lib/api';

interface Display {
  rolling?: number;
  weekly?: number;
  monthly?: number;
}

function Bar({ label, value }: { label: string; value?: number }) {
  if (value === undefined) return null;
  const color =
    value >= 90 ? 'bg-red-500' : value >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-6 text-right text-[11px] text-neutral-400">{label}</span>
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
        <div
          className={'h-full rounded-full ' + color}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
      <span className="w-8 text-[11px] text-neutral-500 tabular-nums">{value}%</span>
    </div>
  );
}

export default function QuotaBadge() {
  const [u, setU] = useState<Display | null>(null);

  useEffect(() => {
    api
      .usage()
      .then((r) =>
        setU({
          rolling: r.usage?.rolling?.percent,
          weekly: r.usage?.weekly?.percent,
          monthly: r.usage?.monthly?.percent,
        }),
      )
      .catch(() => {});
  }, []);

  if (!u) return null;

  return (
    <div
      className="flex items-center gap-3"
      title="OpenCode Go 系统共享额度（非按用户计量）"
    >
      <span className="text-[11px] text-neutral-400">系统额度</span>
      <Bar label="5h" value={u.rolling} />
      <Bar label="周" value={u.weekly} />
      <Bar label="月" value={u.monthly} />
    </div>
  );
}
