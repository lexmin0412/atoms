import { config } from '../config';
import { query } from '../db';

/** 该应用的 Postgres schema 名（由 projectId 派生，安全字符集） */
export function schemaFor(projectId: string): string {
  return `app_${projectId.replace(/-/g, '').slice(0, 20)}`;
}

/** 发布时确保该应用的独立 schema 存在 */
export async function ensureAppSchema(projectId: string): Promise<string> {
  const schema = schemaFor(projectId);
  await query(`create schema if not exists ${schema}`);
  return schema;
}

/** 供生成的应用后端使用：把连接串的 search_path 指到该应用 schema */
export function databaseUrlFor(schema: string): string {
  const base = config.releaseDatabaseUrl || config.databaseUrl;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
