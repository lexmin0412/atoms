import { randomBytes } from 'node:crypto';

import { config } from '../config';
import { appQuery, query } from '../db';

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

/** 该 schema 对应的独立角色名（Postgres 标识符上限 63 字节，这里 ~46） */
export function roleFor(schema: string): string {
  return `r_${schema}`;
}

/** 双引号标识符转义 */
function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 给「自己的 schema」授予最小权限：能建表、能增删改查自己的表；
 * **不给 schema 所有权**（无法删 schema / 越界到其它项目）。
 */
async function grantOwnerRights(schema: string, role: string): Promise<void> {
  const s = q(schema);
  const r = q(role);
  const dbName = new URL(config.appDatabaseUrl).pathname.replace(/^\//, '');
  await appQuery(`grant connect on database ${q(dbName)} to ${r}`).catch(() => {});
  await appQuery(`revoke usage on schema public from ${r}`).catch(() => {});
  await appQuery(`grant usage, create on schema ${s} to ${r}`);
  await appQuery(
    `grant select, insert, update, delete on all tables in schema ${s} to ${r}`,
  );
  await appQuery(`grant usage, select on all sequences in schema ${s} to ${r}`);
  // 存量表 / 后续由管理角色创建的表也要覆盖到
  await appQuery(
    `alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`,
  );
  await appQuery(
    `alter default privileges in schema ${s} grant usage, select on sequences to ${r}`,
  );
}

/** DB 查看用的只读角色 */
async function grantToReadonly(schema: string): Promise<void> {
  const s = q(schema);
  await appQuery(`grant usage on schema ${s} to atoms_ro`).catch(() => {});
  await appQuery(`grant select on all tables in schema ${s} to atoms_ro`).catch(() => {});
}

/**
 * 确保该 schema 有独立的登录角色，并把凭据落到平台库（幂等）。
 * 角色名与密码只在服务端出现，容器拿到的连接串只具备本 schema 的权限。
 */
export async function ensureProjectRole(schema: string): Promise<string> {
  const role = roleFor(schema);
  const existing = await query<{ password: string }>(
    'select password from project_db_roles where schema = $1',
    [schema],
  );

  let password = existing.rows[0]?.password;
  if (!password) {
    password = randomBytes(24).toString('base64url');
    await query(
      `insert into project_db_roles (schema, role_name, password) values ($1, $2, $3)
       on conflict (schema) do nothing`,
      [schema, role, password],
    );
    // 并发下可能已被别的请求写入，读回权威值
    const again = await query<{ password: string }>(
      'select password from project_db_roles where schema = $1',
      [schema],
    );
    password = again.rows[0].password;
  }

  // 角色本身（幂等：存在则同步密码，便于轮换）
  const found = await appQuery<{ n: string }>(
    'select 1 as n from pg_roles where rolname = $1',
    [role],
  );
  if (!found.rowCount) {
    await appQuery(
      `create role ${q(role)} login password '${password.replace(/'/g, "''")}'`,
    );
  } else {
    await appQuery(
      `alter role ${q(role)} with password '${password.replace(/'/g, "''")}'`,
    );
  }

  await grantOwnerRights(schema, role);
  return role;
}

/** 开发沙箱用：确保 dev schema + 独立角色（应用库） */
export async function ensureDevSchema(projectId: string): Promise<string> {
  const schema = devSchemaFor(projectId);
  await appQuery(`create schema if not exists ${q(schema)}`);
  await ensureProjectRole(schema);
  await grantToReadonly(schema);
  return schema;
}

/** 发布用：确保 prod schema + 独立角色（应用库，从空开始） */
export async function ensureAppSchema(projectId: string): Promise<string> {
  const schema = prodSchemaFor(projectId);
  await appQuery(`create schema if not exists ${q(schema)}`);
  await ensureProjectRole(schema);
  await grantToReadonly(schema);
  return schema;
}

/** 拿该 schema 的连接串（用项目角色 + search_path 指向本 schema） */
export async function databaseUrlFor(schema: string): Promise<string> {
  const role = await ensureProjectRole(schema);
  const cred = await query<{ password: string }>(
    'select password from project_db_roles where schema = $1',
    [schema],
  );
  const password = cred.rows[0].password;

  const u = new URL(config.releaseDatabaseUrl || config.appDatabaseUrl);
  u.username = role;
  u.password = password;
  if (!u.searchParams.has('options')) {
    u.searchParams.set('options', `-c search_path=${schema}`);
  }
  return u.toString();
}

/** db:init 回填：给所有已存在的项目 schema 补角色（幂等） */
export async function provisionAllProjectRoles(): Promise<number> {
  // 只匹配真正的项目 schema：p<uuid>_dev|_prod
  const r = await appQuery<{ nspname: string }>(
    `select nspname from pg_namespace
      where nspname ~ '^p[0-9a-f-]{36}_(dev|prod)$'`,
  );
  let n = 0;
  for (const row of r.rows) {
    await ensureProjectRole(row.nspname);
    await grantToReadonly(row.nspname);
    n += 1;
  }
  return n;
}
