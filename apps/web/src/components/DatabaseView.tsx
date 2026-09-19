import { useEffect, useState } from 'react';

import { api } from '../lib/api';

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
  const [tables, setTables] = useState<Table[] | null>(null);
  const [active, setActive] = useState<string>('');
  const [columns, setColumns] = useState<Column[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    api
      .dbAvailability(projectId)
      .then((r) => {
        setAvailability(r);
        // 默认选有数据的一侧
        if (r.dev.available) setEnv('dev');
        else if (r.prod.available) setEnv('prod');
      })
      .catch(() =>
        setAvailability({
          dev: { available: false, tables: 0 },
          prod: { available: false, tables: 0 },
        }),
      );
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
      })
      .catch(() => setTables([]));
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

  if (!availability) return <p className="p-4 text-sm text-neutral-400">加载中…</p>;

  const anyAvailable = availability.dev.available || availability.prod.available;
  if (!anyAvailable) {
    return (
      <p className="p-4 text-sm text-neutral-500">
        该项目还没有数据库表。等应用（后端）真正建表后，这里可分别查看开发/生产数据。
      </p>
    );
  }

  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1.5 text-xs dark:border-neutral-800">
        {(['dev', 'prod'] as Env2[]).map((e) => (
          <button
            key={e}
            disabled={!availability[e].available}
            onClick={() => setEnv(e)}
            className={
              'rounded px-2 py-0.5 disabled:opacity-40 ' +
              (env === e
                ? 'bg-neutral-100 font-medium dark:bg-neutral-800'
                : 'text-neutral-500')
            }
            title={
              availability[e].available ? `${availability[e].tables} 张表` : '暂无数据表'
            }
          >
            {e === 'dev' ? '开发' : '生产'}
          </button>
        ))}
        <span className="ml-2 text-neutral-400">
          {env === 'dev' ? 'dev_ 开发库' : 'app_ 生产库'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-40 shrink-0 overflow-y-auto border-r border-neutral-200 py-2 text-xs dark:border-neutral-800">
          {(tables ?? []).map((t) => (
            <button
              key={t.name}
              onClick={() => {
                setActive(t.name);
                setPage(1);
              }}
              className={
                'block w-full truncate px-3 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ' +
                (active === t.name
                  ? 'bg-neutral-100 font-medium dark:bg-neutral-800'
                  : '')
              }
              title={t.rows === null ? t.name : `${t.name}（约 ${t.rows} 行）`}
            >
              {t.name}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">
            {columns.map((c) => (
              <span key={c.name} className="mr-3 inline-block">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  {c.name}
                </span>
                <span className="ml-1 text-neutral-400">{c.type}</span>
              </span>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-neutral-50 dark:bg-neutral-900">
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.name}
                      className="border-b border-neutral-200 px-2 py-1 font-medium whitespace-nowrap dark:border-neutral-800"
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="odd:bg-neutral-50/50 dark:odd:bg-neutral-900/40">
                    {columns.map((c) => (
                      <td
                        key={c.name}
                        className={
                          'max-w-[240px] truncate border-b border-neutral-100 px-2 py-1 dark:border-neutral-800 ' +
                          (r[c.name] === null ? 'text-neutral-400 italic' : '')
                        }
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
                      className="px-2 py-3 text-neutral-400"
                      colSpan={columns.length || 1}
                    >
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2 border-t border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800">
            <span className="text-neutral-500">
              共 {total} 行 · 第 {page}/{pages} 页
            </span>
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="ml-auto rounded border border-neutral-300 px-2 py-0.5 disabled:opacity-40 dark:border-neutral-700"
            >
              上一页
            </button>
            <button
              disabled={page >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              className="rounded border border-neutral-300 px-2 py-0.5 disabled:opacity-40 dark:border-neutral-700"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
