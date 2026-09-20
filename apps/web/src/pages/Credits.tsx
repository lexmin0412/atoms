import type { ProjectDto } from '@atoms/shared';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { api, type CreditSummary, type LedgerEntry } from '../lib/api';
import { cx } from '../lib/cx';

const REASON_LABEL: Record<string, string> = {
  grant: '周期发放',
  usage: '生成消耗',
  adjust: '手动调整',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Metric({
  label,
  value,
  sub,
  emphasis = false,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={cx('panel p-4', emphasis && 'border-accent/35 bg-accent/6')}>
      <p className="text-muted-foreground text-[11.5px]">{label}</p>
      <p
        className={cx(
          'tnum mt-2 text-[24px] leading-none font-semibold tracking-[-0.02em]',
          emphasis && 'text-accent',
        )}
      >
        {value}
      </p>
      {sub && <p className="text-muted-foreground mt-2 text-[11.5px]">{sub}</p>}
    </div>
  );
}

export default function Credits() {
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState('');
  const [ledgerError, setLedgerError] = useState('');

  // 「重试」按钮用（事件回调里改 state，符合 oxlint 规则）
  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.credits());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '积分信息加载失败');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .credits()
      .then((r) => {
        if (cancelled) return;
        setSummary(r);
        setError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '积分信息加载失败');
        }
      });
    api
      .listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .creditsLedger(page, projectId || undefined)
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows);
        setTotal(r.total);
        setLedgerError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setTotal(0);
        setLedgerError(err instanceof Error ? err.message : '明细加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [page, projectId]);

  const pages = Math.max(1, Math.ceil(total / 20));
  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.title ?? id.slice(0, 8)) : '—';

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-7">
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]">积分</h1>
        <p className="text-muted-foreground mt-1 text-[12.5px]">
          按 token 计量，1 积分 = $0.01 · 每月自动补满
        </p>
      </div>

      {error && !summary && (
        <div className="panel mb-8 flex items-center gap-3 p-4">
          <span className="text-danger min-w-0 flex-1 text-[12.5px] break-words">
            {error}
          </span>
          <Button size="sm" variant="outline" onClick={() => void loadSummary()}>
            重试
          </Button>
        </div>
      )}

      {summary && (
        <div className="mb-8 grid gap-3 sm:grid-cols-3">
          <Metric
            label="当前余额"
            value={summary.balance.toFixed(2)}
            sub={`≈ $${(summary.balance / 100).toFixed(4)}`}
            emphasis
          />
          <Metric
            label={`本周期已用（${summary.period}）`}
            value={summary.spent.toFixed(2)}
            sub={`≈ $${(summary.spent / 100).toFixed(4)}`}
          />
          <Metric
            label="每月额度"
            value={String(summary.monthlyGrant)}
            sub="未用完不累积"
          />
        </div>
      )}

      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-[13.5px] font-medium">明细</h2>
        <select
          value={projectId}
          onChange={(e) => {
            setPage(1);
            setProjectId(e.target.value);
          }}
          className="border-border bg-surface text-muted-foreground hover:border-border-strong focus:border-ring h-8 rounded-sm border px-2 text-[12.5px] focus:outline-none"
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <Badge className="ml-auto">共 {total} 条</Badge>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-[12.5px] whitespace-nowrap lg:whitespace-normal">
          <thead className="bg-muted/50 text-muted-foreground text-[11.5px]">
            <tr>
              <th className="px-3 py-2 font-normal">时间</th>
              <th className="px-3 py-2 font-normal">类型</th>
              <th className="px-3 py-2 font-normal">项目</th>
              <th className="px-3 py-2 font-normal">说明</th>
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
                <tr key={r.id} className="border-border border-t">
                  <td className="tnum text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {fmtTime(r.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={r.reason === 'usage' ? 'neutral' : 'accent'}>
                      {REASON_LABEL[r.reason] ?? r.reason}
                    </Badge>
                  </td>
                  <td className="text-muted-foreground max-w-32 truncate px-3 py-2">
                    {projectName(r.project_id)}
                  </td>
                  <td className="text-muted-foreground max-w-44 truncate px-3 py-2">
                    {note}
                  </td>
                  <td
                    className={cx(
                      'tnum px-3 py-2 text-right font-medium',
                      delta >= 0 ? 'text-success' : 'text-foreground/85',
                    )}
                  >
                    {delta >= 0 ? '+' : ''}
                    {delta.toFixed(2)}
                  </td>
                  <td className="tnum text-muted-foreground px-3 py-2 text-right">
                    {Number(r.balance_after).toFixed(2)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className={cx(
                    'px-3 py-12 text-center',
                    ledgerError ? 'text-danger' : 'text-muted-foreground',
                  )}
                >
                  {ledgerError || '暂无记录'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <span className="tnum text-muted-foreground text-[12.5px]">
            {page} / {pages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}
    </div>
  );
}
