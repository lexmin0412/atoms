import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../db';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(here, '../schema.sql'), 'utf8');

const sql = schema.trim();
const client = await pool.connect();
try {
  await client.query(sql);
  console.log('[db:init] schema applied');
} finally {
  client.release();
  await pool.end();
}
