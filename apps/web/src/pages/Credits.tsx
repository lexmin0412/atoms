import type { ProjectDto } from '@atoms/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type CreditSummary, type LedgerEntry } from '../lib/api';

const REASON_LABEL: Record<string, string> = {
  grant: '周期发放',
  usage: '生成消耗',
  adjust: '管理员调整',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Credits() {
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<ProjectDto[]>([]);

  useEffect(() => {
    api
      .credits()
      .then(setSummary)
      .catch(() => {});
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .creditsLedger(page, projectId || undefined)
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [page, projectId]);

  const pages = Math.max(1, Math.ceil(total / 20));
  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.title ?? id.slice(0, 8)) : '—';

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6 flex items-center gap-3">
        <Link
          to="/"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
        >
          ← 返回
        </Link>
        <h1 className="text-lg font-medium">积分</h1>
      </header>

      {summary && (
        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-xs text-neutral-500">剩余</p>
            <p className="mt-1 text-2xl font-medium tabular-nums">
              {summary.balance.toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-xs text-neutral-500">本周期已用（{summary.period}）</p>
            <p className="mt-1 text-2xl font-medium tabular-nums">
              {summary.spent.toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-xs text-neutral-500">每月补满到</p>
            <p className="mt-1 text-2xl font-medium tabular-nums">
              {summary.monthlyGrant}
            </p>
          </div>
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        <select
          value={projectId}
          onChange={(e) => {
            setPage(1);
            setProjectId(e.target.value);
          }}
          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-400">共 {total} 条（1 积分 = $0.01）</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-xs text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 text-left font-normal">时间</th>
              <th className="px-3 py-2 text-left font-normal">类型</th>
              <th className="px-3 py-2 text-left font-normal">项目</th>
              <th className="px-3 py-2 text-left font-normal">说明</th>
              <th className="px-3 py-2 text-right font-normal">变动</th>
              <th className="px-3 py-2 text-right font-normal">余额</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const delta = Number(r.delta);
              const note =
                r.reason === 'adjust'
                  ? String((r.meta as { note?: string }).note ?? '')
                  : r.reason === 'grant'
                    ? String((r.meta as { period?: string }).period ?? '')
                    : String((r.meta as { model?: string }).model ?? '');
              return (
                <tr
                  key={r.id}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                >
                  <td className="px-3 py-2 whitespace-nowrap text-neutral-500">
                    {fmtTime(r.created_at)}
                  </td>
                  <td className="px-3 py-2">{REASON_LABEL[r.reason] ?? r.reason}</td>
                  <td className="max-w-32 truncate px-3 py-2 text-neutral-500">
                    {projectName(r.project_id)}
                  </td>
                  <td className="max-w-40 truncate px-3 py-2 text-neutral-500">{note}</td>
                  <td
                    className={
                      'px-3 py-2 text-right tabular-nums ' +
                      (delta >= 0
                        ? 'text-emerald-600'
                        : 'text-neutral-600 dark:text-neutral-300')
                    }
                  >
                    {delta >= 0 ? '+' : ''}
                    {delta.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {Number(r.balance_after).toFixed(2)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-neutral-400">
                  暂无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40 dark:border-neutral-700"
          >
            上一页
          </button>
          <span className="text-neutral-500">
            {page} / {pages}
          </span>
          <button
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40 dark:border-neutral-700"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
