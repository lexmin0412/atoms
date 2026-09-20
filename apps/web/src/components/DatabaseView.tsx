import { useCallback, useEffect, useState } from 'react';

import { api } from '../lib/api';
import { cx } from '../lib/cx';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { IconTable } from './ui/icons';
import { Segmented } from './ui/Segmented';

type Env2 = 'dev' | 'prod';
type Table = { name: string; rows: number | null };
type Column = { name: string; type: string; nullable: boolean };

function cell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 应用数据库查看（只读）。开发 / 生产分开查看；
 * 仅当对应环境真正有业务表时才可用（纯前端项目看不到内容）。
 */
export default function DatabaseView({ projectId }: { projectId: string }) {
  const [availability, setAvailability] = useState<{
    dev: { available: boolean; tables: number };
    prod: { available: boolean; tables: number };
  } | null>(null);
  const [env, setEnv] = useState<Env2>('dev');
  const [view, setView] = useState<'data' | 'fields'>('data');
  const [tables, setTables] = useState<Table[] | null>(null);
  const [active, setActive] = useState<string>('');
  const [columns, setColumns] = useState<Column[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  /** 加载失败与「真的没有表」必须分开：以前失败会被显示成「还没有数据库表」 */
  const [error, setError] = useState('');

  const loadAvailability = useCallback(async () => {
    try {
      const r = await api.dbAvailability(projectId);
      setAvailability(r);
      setError('');
      if (r.dev.available) setEnv('dev');
      else if (r.prod.available) setEnv('prod');
    } catch (err) {
      setAvailability(null);
      setError(err instanceof Error ? err.message : '数据库信息加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    api
      .dbAvailability(projectId)
      .then((r) => {
        if (cancelled) return;
        setAvailability(r);
        setError('');
        if (r.dev.available) setEnv('dev');
        else if (r.prod.available) setEnv('prod');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAvailability(null);
        setError(err instanceof Error ? err.message : '数据库信息加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!availability) return;
    if (!availability[env].available) {
      Promise.resolve().then(() => {
        setTables([]);
        setActive('');
      });
      return;
    }
    Promise.resolve().then(() => {
      setTables(null);
      setPage(1);
    });
    api
      .dbTables(projectId, env)
      .then((r) => {
        setTables(r.tables);
        setActive(r.tables[0]?.name ?? '');
        setError('');
      })
      .catch((err: unknown) => {
        setTables([]);
        setActive('');
        setError(err instanceof Error ? err.message : '数据表加载失败');
      });
  }, [projectId, env, availability]);

  useEffect(() => {
    if (!active) {
      Promise.resolve().then(() => {
        setColumns([]);
        setRows([]);
      });
      return;
    }
    api
      .dbColumns(projectId, env, active)
      .then((r) => setColumns(r.columns))
      .catch(() => {});
    api
      .dbRows(projectId, env, active, page)
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch(() => {});
  }, [projectId, env, active, page]);

  if (!availability) {
    if (error) {
      return (
        <div className="grid flex-1 place-items-center p-6">
          <div className="text-center">
            <p className="text-danger text-[12.5px] break-words">{error}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => void loadAvailability()}
            >
              重试
            </Button>
          </div>
        </div>
      );
    }
    return <p className="text-muted-foreground p-4 text-[12.5px]">加载中…</p>;
  }

  const anyAvailable = availability.dev.available || availability.prod.available;
  if (!anyAvailable) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <p className="text-muted-foreground max-w-[42ch] text-center text-[12.5px] leading-relaxed">
          该项目还没有数据库表。等应用（后端）真正建表后，这里可分别查看开发 / 生产数据。
        </p>
      </div>
    );
  }

  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-2.5">
        <Segmented
          value={env}
          onChange={setEnv}
          items={[
            { value: 'dev' as Env2, label: '开发' },
            { value: 'prod' as Env2, label: '生产' },
          ]}
        />
        <span className="text-muted-foreground truncate font-mono text-[11px]">
          {active || (env === 'dev' ? 'dev 库' : 'prod 库')}
        </span>
        <div className="ml-auto">
          <Segmented
            value={view}
            onChange={setView}
            items={[
              { value: 'data' as const, label: '数据' },
              { value: 'fields' as const, label: '字段' },
            ]}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="border-border w-32 shrink-0 overflow-y-auto border-r py-1.5 sm:w-44">
          {error && (tables ?? []).length === 0 && (
            <p className="text-danger px-2.5 py-1 text-[11px] break-words">{error}</p>
          )}
          {(tables ?? []).map((t) => (
            <button
              key={t.name}
              onClick={() => {
                setActive(t.name);
                setPage(1);
              }}
              className={cx(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors',
                active === t.name
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              title={t.rows === null ? t.name : `${t.name}（约 ${t.rows} 行）`}
            >
              <IconTable size={13} />
              <span className="truncate font-mono text-[11.5px]">{t.name}</span>
              {t.rows !== null && (
                <span className="tnum text-muted-foreground/60 ml-auto shrink-0 text-[10.5px]">
                  {t.rows}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {view === 'fields' ? (
            /* 字段 */
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full text-left">
                <thead className="bg-muted/80 text-muted-foreground sticky top-0 text-[11.5px] backdrop-blur-sm">
                  <tr>
                    <th className="border-border border-b px-3 py-2 font-normal">字段</th>
                    <th className="border-border border-b px-3 py-2 font-normal">类型</th>
                    <th className="border-border border-b px-3 py-2 font-normal">约束</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c) => (
                    <tr key={c.name} className="border-border border-t">
                      <td className="px-3 py-2 font-mono text-[12px]">{c.name}</td>
                      <td className="text-muted-foreground px-3 py-2 font-mono text-[11.5px]">
                        {c.type}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={c.nullable ? 'neutral' : 'accent'}>
                          {c.nullable ? '可空' : '非空'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                  {columns.length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-muted-foreground px-3 py-6">
                        暂无字段
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="text-muted-foreground px-3 py-2 text-[11.5px]">
                共 {columns.length} 个字段
              </div>
            </div>
          ) : (
            /* 数据 */
            <>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-left font-mono text-[11.5px]">
                  <thead className="bg-muted/80 sticky top-0 backdrop-blur-sm">
                    <tr>
                      {columns.map((c) => (
                        <th
                          key={c.name}
                          className="border-border border-b px-2 py-1.5 font-medium whitespace-nowrap"
                        >
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="odd:bg-muted/35">
                        {columns.map((c) => (
                          <td
                            key={c.name}
                            className={cx(
                              'max-w-[240px] truncate border-b border-border/60 px-2 py-1',
                              r[c.name] === null && 'text-muted-foreground/70 italic',
                            )}
                            title={cell(r[c.name])}
                          >
                            {cell(r[c.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td
                          className="text-muted-foreground px-2 py-4"
                          colSpan={columns.length || 1}
                        >
                          暂无数据
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="border-border flex items-center gap-2 border-t px-3 py-1.5">
                <Badge>
                  <span className="tnum">
                    {total} 行 · {page}/{pages}
                  </span>
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                >
                  下一页
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
