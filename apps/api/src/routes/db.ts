import { Hono } from 'hono';

import { requireUser } from '../auth';
import { query } from '../db';
import {
  devSchemaFor,
  prodSchemaFor,
  schemaExists,
  hasTables,
  listTables,
  tableExists,
  listColumns,
  listRows,
} from '../release/readonly';
import type { Env } from './auth';

export const dbRoutes = new Hono<Env>();

dbRoutes.use('*', requireUser);

async function ownedProject(projectId: string, userId: string) {
  const r = await query('select 1 from projects where id = $1 and user_id = $2', [
    projectId,
    userId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

type Env2 = 'dev' | 'prod';
function schemaForEnv(projectId: string, env: Env2) {
  return env === 'prod' ? prodSchemaFor(projectId) : devSchemaFor(projectId);
}

function parseEnv(v: string | undefined): Env2 {
  return v === 'prod' ? 'prod' : 'dev';
}

/** 入口可见性：开发/生产各自的 schema 是否存在且**有表**（纯前端项目看不到） */
dbRoutes.get('/:id/db/availability', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  if (!(await ownedProject(id, user.id))) return c.json({ error: 'not_found' }, 404);

  const check = async (env: Env2) => {
    const schema = schemaForEnv(id, env);
    if (!(await schemaExists(schema))) return { available: false, tables: 0 };
    const tables = (await listTables(schema)).length;
    return { available: tables > 0, tables };
  };
  const [dev, prod] = await Promise.all([check('dev'), check('prod')]);
  return c.json({ dev, prod });
});

/** 校验归属 + schema 有表；不可用则返回 Response */
async function guard(c: {
  get: (k: 'user') => { id: string };
  req: {
    param: (k: string) => string | undefined;
    query: (k: string) => string | undefined;
  };
  json: (b: unknown, s?: number) => Response;
}): Promise<{ schema: string; env: Env2 } | Response> {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  if (!(await ownedProject(id, user.id))) return c.json({ error: 'not_found' }, 404);

  const env = parseEnv(c.req.query('env'));
  const schema = schemaForEnv(id, env);
  if (!(await schemaExists(schema)) || !(await hasTables(schema))) {
    return c.json({ error: 'unavailable', message: '暂无数据表' }, 404);
  }
  return { schema, env };
}

dbRoutes.get('/:id/db/tables', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  return c.json({ env: g.env, tables: await listTables(g.schema) });
});

dbRoutes.get('/:id/db/tables/:table', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const table = c.req.param('table') ?? '';
  if (!(await tableExists(g.schema, table))) {
    return c.json({ error: 'table_not_found' }, 404);
  }
  return c.json({ table, columns: await listColumns(g.schema, table) });
});

dbRoutes.get('/:id/db/tables/:table/rows', async (c) => {
  const g = await guard(c);
  if (g instanceof Response) return g;
  const table = c.req.param('table') ?? '';
  if (!(await tableExists(g.schema, table))) {
    return c.json({ error: 'table_not_found' }, 404);
  }
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  return c.json(await listRows(g.schema, table, page, 50));
});
