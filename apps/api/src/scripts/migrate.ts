import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import { appPool, pool } from '../db';

const here = dirname(fileURLToPath(import.meta.url));

/** 在平台库执行 schema + 所有未执行的迁移（幂等） */
export async function migratePlatform() {
  const client = await pool.connect();
  try {
    await client.query(readFileSync(resolve(here, '../schema.sql'), 'utf8').trim());
    console.log('[db:init] platform schema applied');
    await runMigrations(client, resolve(here, '../migrations'));
  } finally {
    client.release();
  }
}

/** 在应用库执行只读角色授权 */
export async function grantAppDbReadonly() {
  const client = await appPool.connect();
  try {
    const sql = readFileSync(resolve(here, '../schema-ro.sql'), 'utf8').trim();
    await client.query(sql);
    console.log('[db:init] app-db readonly grants applied');
  } catch (err) {
    console.warn(
      '[db:init] app-db readonly grants skipped:',
      (err as Error).message.split('\n')[0],
    );
  } finally {
    client.release();
  }
}

async function runMigrations(client: pg.PoolClient, dir: string) {
  await client.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const done = await client.query('select 1 from schema_migrations where name = $1', [
      file,
    ]);
    if (done.rowCount) continue;
    const sql = readFileSync(join(dir, file), 'utf8').trim();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      console.log(`[db:init] migration applied: ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
}
