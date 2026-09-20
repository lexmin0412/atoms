import pg from 'pg';

import { config } from '../config';
import { appQuery } from '../db';

/**
 * 只读数据访问（数据库查看用）。
 * - 使用只读角色连接（仅能读项目 schema）
 * - 表名/列名一律先经白名单校验，再以双引号标识符转义后拼接
 * - 行数据固定 LIMIT/OFFSET 参数化
 */

let roPool: pg.Pool | null = null;

function getRoPool(): pg.Pool {
  if (!roPool) {
    // 用户项目数据在应用库；只读角色也在应用库授权
    const connectionString =
      config.readonlyDatabaseUrl || config.appDatabaseUrl || config.databaseUrl;
    if (!config.readonlyDatabaseUrl) {
      // 明确告警：此处退回管理连接会让「只读」边界失效（启动校验也会提示）
      console.warn('[readonly] READONLY_DATABASE_URL 未配置：数据库查看退回管理连接');
    }
    roPool = new pg.Pool({ connectionString, max: 4 });
  }
  return roPool;
}

/**
 * 兜底授权：应用运行时会新建表，而建 schema 时的 GRANT 不覆盖后建的表。
 * 在查询前（由拥有者身份）补一次该 schema 的只读授权，幂等且便宜。
 */
async function ensureReadable(schema: string) {
  const q = `"${schema}"`;
  await appQuery(`grant usage on schema ${q} to atoms_ro`).catch(() => {});
  await appQuery(`grant select on all tables in schema ${q} to atoms_ro`).catch(() => {});
}

/** 双引号标识符转义（防注入） */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 开发/生产两个 schema 名（与 release/db.ts 保持一致） */
export function devSchemaFor(projectId: string): string {
  return `p${projectId}_dev`;
}
export function prodSchemaFor(projectId: string): string {
  return `p${projectId}_prod`;
}

/** 某 schema 下是否存在业务表（用于判断入口是否可见） */
export async function hasTables(schema: string): Promise<boolean> {
  const r = await getRoPool().query(
    `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind = 'r' limit 1`,
    [schema],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function schemaExists(schema: string): Promise<boolean> {
  const r = await getRoPool().query('select 1 from pg_namespace where nspname = $1', [
    schema,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function listTables(schema: string) {
  const r = await getRoPool().query<{ table_name: string; rows: string }>(
    `select c.relname as table_name, c.reltuples::bigint::text as rows
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind = 'r'
      order by c.relname`,
    [schema],
  );
  return r.rows.map((x) => {
    const n = Number(x.rows);
    // reltuples 在未 analyze 时为 -1（估算未知），返回 null 让前端不展示
    return { name: x.table_name, rows: n < 0 ? null : n };
  });
}

/** 白名单：表是否存在于该 schema */
export async function tableExists(schema: string, table: string): Promise<boolean> {
  const r = await getRoPool().query(
    `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind = 'r'`,
    [schema, table],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listColumns(schema: string, table: string) {
  await ensureReadable(schema);
  const r = await getRoPool().query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = $1 and table_name = $2
      order by ordinal_position`,
    [schema, table],
  );
  return r.rows.map((c) => ({
    name: c.column_name,
    type: c.data_type,
    nullable: c.is_nullable === 'YES',
    default: c.column_default,
  }));
}

export async function listRows(
  schema: string,
  table: string,
  page: number,
  pageSize: number,
) {
  await ensureReadable(schema);
  const pool = getRoPool();
  const totalR = await pool.query<{ n: string }>(
    `select count(*)::bigint::text as n from ${quoteIdent(schema)}.${quoteIdent(table)}`,
  );
  const total = Number(totalR.rows[0]?.n ?? 0);
  const offset = (page - 1) * pageSize;
  const rowsR = await pool.query(
    `select * from ${quoteIdent(schema)}.${quoteIdent(table)}
      order by 1 limit $1 offset $2`,
    [pageSize, offset],
  );
  return { rows: rowsR.rows, total, page, pageSize };
}
