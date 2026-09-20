import { randomBytes } from 'node:crypto';

import pg from 'pg';

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

/** 单引号字符串字面量（转义） */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * 给「自己的 schema」授予权限并把既有对象的所有权交给它。
 *
 * 为什么要转 owner：生成的 app 启动时通常自己跑迁移
 * （`create table if not exists`、`alter table add column`、`create index`），
 * `alter` 系列需要**表的所有权**，仅有增删改查权限会报 `must be owner of table`。
 * 只转 schema 内对象，schema 本身仍归管理角色 —— 项目角色删不掉 schema、也越不了界。
 */
async function grantOwnerRights(
  schema: string,
  role: string,
  password: string,
): Promise<void> {
  const s = q(schema);
  const r = q(role);
  const parsed = new URL(config.appDatabaseUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  const adminRole = q(decodeURIComponent(parsed.username));
  await appQuery(`grant connect on database ${q(dbName)} to ${r}`).catch(() => {});
  await appQuery(`revoke usage on schema public from ${r}`).catch(() => {});
  await appQuery(`grant usage, create on schema ${s} to ${r}`);

  // `alter ... owner to` 要求当前角色能 SET ROLE 到目标角色；
  // PG16 的成员关系默认不带 SET 权限（历史回填的角色尤其如此），这里显式补上（幂等）。
  await appQuery(`grant ${r} to ${adminRole} with set true`).catch(() => {});

  // 既有表 / 序列：所有权交给项目角色
  await appQuery(`
    do $$
    declare rec record;
    begin
      for rec in select tablename from pg_tables where schemaname = ${lit(schema)} loop
        execute format('alter table %I.%I owner to %I', ${lit(schema)}, rec.tablename, ${lit(role)});
      end loop;
      for rec in select sequencename from pg_sequences where schemaname = ${lit(schema)} loop
        execute format('alter sequence %I.%I owner to %I', ${lit(schema)}, rec.sequencename, ${lit(role)});
      end loop;
    end $$;
  `);

  // 兜底授权（对象已被转移，这里覆盖“转移后新建但非本角色创建”的极端情况）+ 未来对象
  await appQuery(
    `grant select, insert, update, delete on all tables in schema ${s} to ${r}`,
  );
  await appQuery(`grant usage, select on all sequences in schema ${s} to ${r}`);
  await appQuery(
    `alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`,
  );
  await appQuery(
    `alter default privileges in schema ${s} grant usage, select on sequences to ${r}`,
  );

  // DB 查看用的只读角色：只有对象 owner 才有权授出 → 用项目角色自己的连接来授权。
  // 不用 SET ROLE：PG16 的成员关系可能缺 set_option，且管理角色不该能扮演项目角色。
  await grantReadonlyAsOwner(schema, role, password);
}

/** 以「项目角色自己」的身份，把自己 schema 的读权限授给只读角色 atoms_ro */
async function grantReadonlyAsOwner(
  schema: string,
  role: string,
  password: string,
): Promise<void> {
  const u = new URL(config.appDatabaseUrl);
  u.username = role;
  u.password = password;
  const client = new pg.Client({ connectionString: u.toString() });
  await client.connect();
  try {
    await client.query(`grant usage on schema ${q(schema)} to atoms_ro`);
    await client.query(`grant select on all tables in schema ${q(schema)} to atoms_ro`);
    // 项目角色以后新建的表，也自动可被只读角色读取
    await client.query(
      `alter default privileges in schema ${q(schema)} grant select on tables to atoms_ro`,
    );
  } finally {
    await client.end();
  }
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

  await grantOwnerRights(schema, role, password);
  return role;
}

/** 开发沙箱用：确保 dev schema + 独立角色（应用库） */
export async function ensureDevSchema(projectId: string): Promise<string> {
  const schema = devSchemaFor(projectId);
  await appQuery(`create schema if not exists ${q(schema)}`);
  await ensureProjectRole(schema);
  return schema;
}

/** 发布用：确保 prod schema + 独立角色（应用库，从空开始） */
export async function ensureAppSchema(projectId: string): Promise<string> {
  const schema = prodSchemaFor(projectId);
  await appQuery(`create schema if not exists ${q(schema)}`);
  await ensureProjectRole(schema);
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
    n += 1;
  }
  return n;
}
