import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { pool, query } from '../db';
import { requireUser } from '../auth';
import { signedFetch, signedJson } from '../runtime/http';
import { destroyWorkspace } from '../runtime/manager';
import type { Env } from './auth';

export const projectRoutes = new Hono<Env>();

projectRoutes.use('*', requireUser);

const createSchema = z.object({ title: z.string().min(1).max(120) });

projectRoutes.get('/', async (c) => {
  const user = c.get('user');
  const r = await query(
    `select id, title, status, created_at, updated_at
       from projects where user_id = $1
      order by updated_at desc`,
    [user.id],
  );
  return c.json({ projects: r.rows });
});

projectRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  const r = await query(
    `insert into projects (user_id, title) values ($1, $2)
     returning id, title, status, created_at, updated_at`,
    [user.id, parsed.data.title],
  );
  return c.json({ project: r.rows[0] }, 201);
});

async function ownedProject(projectId: string, userId: string) {
  const r = await query(
    'select id, title, status from projects where id = $1 and user_id = $2',
    [projectId, userId],
  );
  return r.rows[0] ?? null;
}

projectRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const project = await ownedProject(c.req.param('id'), user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  return c.json({ project });
});

/** 重命名项目 */
projectRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const r = await query(
    `update projects set title = $1, updated_at = now()
      where id = $2 and user_id = $3
      returning id, title, status, created_at, updated_at`,
    [parsed.data.title, id, user.id],
  );
  if (!r.rowCount) return c.json({ error: 'not_found' }, 404);
  return c.json({ project: r.rows[0] });
});

/** 删除项目（连同沙箱） */
projectRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const r = await query('delete from projects where id = $1 and user_id = $2', [
    id,
    user.id,
  ]);
  if (!r.rowCount) return c.json({ error: 'not_found' }, 404);
  await destroyWorkspace(id).catch(() => {});
  return c.json({ ok: true });
});

projectRoutes.get('/:id/messages', async (c) => {
  const user = c.get('user');
  const project = await ownedProject(c.req.param('id'), user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const r = await query(
    'select id, seq, role, parts, created_at from messages where project_id = $1 order by seq asc',
    [c.req.param('id')],
  );
  return c.json({ messages: r.rows });
});

/** 项目文件路径列表（文件树用） */
projectRoutes.get('/:id/tree', async (c) => {
  const user = c.get('user');
  const project = await ownedProject(c.req.param('id'), user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const r = await query<{ path: string }>(
    'select path from files where project_id = $1 order by path',
    [c.req.param('id')],
  );
  return c.json({ files: r.rows.map((x) => x.path) });
});

/** 单个文件内容（源码查看用） */
projectRoutes.get('/:id/file', async (c) => {
  const user = c.get('user');
  const project = await ownedProject(c.req.param('id'), user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path_required' }, 400);
  const r = await query<{ content: string }>(
    'select content from files where project_id = $1 and path = $2',
    [c.req.param('id'), path],
  );
  if (!r.rowCount) return c.json({ error: 'not_found' }, 404);
  return c.json({ path, content: r.rows[0].content });
});

/** 预览：把沙箱里 apps/web/dist 的静态产物代理出来（同源 iframe 展示） */
async function servePreview(c: Context<Env>) {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const url = new URL(c.req.url);
  const prefix = `/api/projects/${id}/preview/`;
  const rel = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const res = await signedFetch(`/sandbox/${id}/preview/${rel}`, { method: 'GET' });
  const body = await res.arrayBuffer();
  const ct = res.headers.get('content-type') ?? 'application/octet-stream';
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' },
  });
}

projectRoutes.get('/:id/preview', servePreview);
projectRoutes.get('/:id/preview/*', servePreview);
projectRoutes.get('/:id/preview-version', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const res = await signedFetch(`/sandbox/${id}/preview-version`, { method: 'GET' });
  if (!res.ok) return c.json({ version: '' });
  return c.json(await res.json());
});

/** 一键发布：把构建产物快照到 A，生成公开分享链接 */
projectRoutes.post('/:id/publish', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);

  const snap = await signedJson<{ files: Record<string, string> }>(
    `/sandbox/${id}/dist-snapshot`,
    { method: 'POST' },
  ).catch(() => null);
  const files = snap?.files ?? {};
  if (Object.keys(files).length === 0) {
    return c.json(
      { error: 'not_built', message: '还没有可发布的构建产物，请先让 Agent 构建成功' },
      400,
    );
  }

  const token = randomBytes(9).toString('hex');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('insert into deployments (project_id, token) values ($1, $2)', [
      id,
      token,
    ]);
    for (const [path, b64] of Object.entries(files)) {
      await client.query(
        'insert into share_files (token, path, content_b64) values ($1, $2, $3)',
        [token, path, b64],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return c.json({ url: `/share/${token}/`, token });
});
