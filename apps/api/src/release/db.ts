import { config } from '../config';
import { appQuery } from '../db';

/**
 * 用户项目 schema 命名：p{projectId}_{dev|prod}
 * - 用【完整 projectId】（UUID 本身全局唯一）→ 零碰撞
 * - 不截断、不带 user 维度（项目→用户关系在平台库 projects 表里）
 * - 长度 ~41，低于 Postgres 63 字节标识符上限
 */
export function devSchemaFor(projectId: string): string {
  return `p${projectId}_dev`;
}
export function prodSchemaFor(projectId: string): string {
  return `p${projectId}_prod`;
}

async function grantToReadonly(schema: string) {
  const q = `"${schema}"`;
  await appQuery(`grant usage on schema ${q} to atoms_ro`).catch(() => {});
  await appQuery(`grant select on all tables in schema ${q} to atoms_ro`).catch(() => {});
}

/** 开发沙箱用：确保 dev schema 存在（应用库） */
export async function ensureDevSchema(projectId: string): Promise<string> {
  const schema = devSchemaFor(projectId);
  await appQuery(`create schema if not exists "${schema}"`);
  await grantToReadonly(schema);
  return schema;
}

/** 发布用：确保 prod schema 存在（应用库，从空开始） */
export async function ensureAppSchema(projectId: string): Promise<string> {
  const schema = prodSchemaFor(projectId);
  await appQuery(`create schema if not exists "${schema}"`);
  await grantToReadonly(schema);
  return schema;
}

/** 生成应用后端用的连接串：把 search_path 指到该 schema（指向应用库） */
export function databaseUrlFor(schema: string): string {
  const base = config.releaseDatabaseUrl || config.appDatabaseUrl;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}
