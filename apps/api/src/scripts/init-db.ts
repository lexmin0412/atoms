import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appPool, pool } from '../db';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(here, '../schema.sql'), 'utf8');
const schemaRo = readFileSync(resolve(here, '../schema-ro.sql'), 'utf8');

// 平台库：业务表
{
  const client = await pool.connect();
  try {
    await client.query(schema.trim());
    console.log('[db:init] platform schema applied');
  } finally {
    client.release();
  }
}

// 应用库：只读角色授权
{
  const client = await appPool.connect();
  try {
    await client.query(schemaRo.trim());
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

await pool.end();
await appPool.end();
