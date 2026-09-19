import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { isBusy } from '../agent-busy';
import { requireUser } from '../auth';
import { config } from '../config';
import { query } from '../db';
import {
  createNode,
  deleteNode,
  listTree,
  loadFileMap,
  readFile,
  renameNode,
  updateFile,
} from '../filetree';
import { ensureAppSchema, ensureDevSchema, databaseUrlFor } from '../release/db';
import { publishFrontend } from '../release/frontend';
import { getRuntime, getSandboxRuntime } from '../runtime';
import { signedFetch, signedJson } from '../runtime/http';
import { destroyWorkspace, acquireWorkspace, withWorkspace } from '../runtime/manager';
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

/** 项目文件树 */
projectRoutes.get('/:id/tree', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const nodes = await listTree(id);
  return c.json({ nodes, busy: isBusy(id) });
});

/** 单个文件内容（源码查看用） */
projectRoutes.get('/:id/file', async (c) => {
  const user = c.get('user');
  const project = await ownedProject(c.req.param('id'), user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path_required' }, 400);
  const file = await readFile(c.req.param('id'), path).catch(() => null);
  if (file === null) return c.json({ error: 'not_found' }, 404);
  return c.json({ path, content: file.content, version: file.version });
});

// ---- 文件管理（写操作：生成中禁止；成功后同步开发沙箱）----

/** 把领域错误映射为 HTTP 响应 */
function fsError(c: Context<Env>, err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (msg === 'exists')
    return c.json({ error: 'exists', message: '同名节点已存在' }, 409);
  if (msg === 'conflict') {
    return c.json(
      { error: 'conflict', message: '文件已被更改，请重新加载后再保存' },
      409,
    );
  }
  if (msg === 'parent_not_found' || msg === 'parent_not_dir') {
    return c.json({ error: msg, message: '父目录无效' }, 400);
  }
  console.error('[fs] error:', err);
  return c.json({ error: 'fs_failed', message: msg }, 500);
}

/** 校验写权限：返回错误响应或 null */
async function guardFsWrite(c: Context<Env>, id: string): Promise<Response | null> {
  const user = c.get('user');
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  if (isBusy(id)) {
    return c.json({ error: 'busy', message: '生成中，暂不能编辑文件' }, 409);
  }
  return null;
}

const nodeName = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes('/') && s !== '.' && s !== '..', 'invalid_name');

/** 新建时允许 a/b/c 形式（后端自动建中间目录） */
const newName = z
  .string()
  .min(1)
  .max(400)
  .refine((s) => !s.split('/').some((p) => p === '.' || p === '..'), 'invalid_name');

const createNodeSchema = z.object({
  parentId: z.string().uuid().nullish(),
  name: newName,
  content: z.string().optional(),
});

/** 新建文件 */
projectRoutes.post('/:id/fs/file', async (c) => {
  const id = c.req.param('id');
  const guard = await guardFsWrite(c, id);
  if (guard) return guard;
  const parsed = createNodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  try {
    const node = await createNode(
      id,
      parsed.data.parentId ?? null,
      parsed.data.name,
      'file',
      parsed.data.content ?? '',
    );
    await withWorkspace(id, (rt, ws) =>
      rt.writeFile(ws, node.path, parsed.data.content ?? ''),
    );
    return c.json({ node }, 201);
  } catch (err) {
    return fsError(c, err);
  }
});

/** 新建目录（支持空目录） */
projectRoutes.post('/:id/fs/dir', async (c) => {
  const id = c.req.param('id');
  const guard = await guardFsWrite(c, id);
  if (guard) return guard;
  const parsed = createNodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  try {
    const node = await createNode(
      id,
      parsed.data.parentId ?? null,
      parsed.data.name,
      'dir',
      '',
    );
    return c.json({ node }, 201);
  } catch (err) {
    return fsError(c, err);
  }
});

/** 保存文件（乐观锁） */
projectRoutes.put('/:id/fs/file/:nodeId', async (c) => {
  const id = c.req.param('id');
  const guard = await guardFsWrite(c, id);
  if (guard) return guard;
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({ content: z.string(), version: z.number().int().nonnegative() })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const nodeId = c.req.param('nodeId');
  try {
    const r = await updateFile(id, nodeId, parsed.data.content, parsed.data.version);
    const node = await listTree(id).then((ns) => ns.find((n) => n.id === nodeId));
    if (node) {
      await withWorkspace(id, (rt, ws) =>
        rt.writeFile(ws, node.path, parsed.data.content),
      );
    }
    return c.json({ version: r.version });
  } catch (err) {
    return fsError(c, err);
  }
});

/** 重命名 / 移动 */
projectRoutes.put('/:id/fs/node/:nodeId/rename', async (c) => {
  const id = c.req.param('id');
  const guard = await guardFsWrite(c, id);
  if (guard) return guard;
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({ name: nodeName, parentId: z.string().uuid().nullish() })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const nodeId = c.req.param('nodeId');
  try {
    const r = await renameNode(id, nodeId, parsed.data.name, parsed.data.parentId);
    const map = await loadFileMap(id);
    await withWorkspace(id, async (rt, ws) => {
      for (const m of r.moves) {
        await rt.deleteFile(ws, m.from);
        if (map[m.to] !== undefined) await rt.writeFile(ws, m.to, map[m.to]);
      }
    });
    return c.json({ path: r.path });
  } catch (err) {
    return fsError(c, err);
  }
});

/** 删除（目录递归） */
projectRoutes.delete('/:id/fs/node/:nodeId', async (c) => {
  const id = c.req.param('id');
  const guard = await guardFsWrite(c, id);
  if (guard) return guard;
  try {
    const r = await deleteNode(id, c.req.param('nodeId'));
    await withWorkspace(id, async (rt, ws) => {
      for (const p of r.files) await rt.deleteFile(ws, p);
    });
    return c.json({ ok: true });
  } catch (err) {
    return fsError(c, err);
  }
});

/** 重新构建：前端构建 + 重启开发预览后端 */
projectRoutes.post('/:id/rebuild', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  if (isBusy(id)) return c.json({ error: 'busy', message: '生成中，请稍后再构建' }, 409);

  const schema = await ensureDevSchema(id);
  const rt = getSandboxRuntime();
  await acquireWorkspace(id).catch(() => {});

  const log: string[] = [];
  try {
    const ws = await acquireWorkspace(id);
    for await (const chunk of getRuntime().exec(
      ws,
      'cd /workspace && pnpm install --prefer-offline && pnpm -r build',
    )) {
      if (chunk.data) log.push(chunk.data);
      if (chunk.exitCode !== undefined && chunk.exitCode !== 0) {
        return c.json({ error: 'build_failed', message: log.join('').slice(-4000) }, 500);
      }
    }
    const listing = await signedJson<{ files: string[] }>(`/sandbox/${id}/files`, {
      method: 'GET',
    }).catch(() => ({ files: [] as string[] }));
    if (listing.files.some((f) => f.startsWith('apps/api/'))) {
      await rt.restartDevApp(id, databaseUrlFor(schema));
    }
    return c.json({ ok: true, log: log.join('').slice(-4000) });
  } catch (err) {
    return c.json(
      {
        error: 'build_failed',
        message: (err as Error).message,
        log: log.join('').slice(-4000),
      },
      500,
    );
  }
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

/** 预览地址（独立子域，避免 /api 落到平台） */
projectRoutes.get('/:id/preview-url', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  return c.json({ url: `https://dev-${id}.atoms.lexmin.cn/` });
});

/** 启动开发应用后端（供预览子域的 /api 使用）；纯前端项目可忽略 */
projectRoutes.post('/:id/devapp', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);

  // 仅在项目含 apps/api 时启动
  const listing = await signedJson<{ files: string[] }>(`/sandbox/${id}/files`, {
    method: 'GET',
  }).catch(() => ({ files: [] as string[] }));
  const hasBackend = listing.files.some((f) => f.startsWith('apps/api/'));
  if (!hasBackend) return c.json({ hasBackend: false, ready: true });

  const schema = await ensureDevSchema(id);
  // 先确保开发沙箱存在（可能已被空闲回收）
  await acquireWorkspace(id).catch(() => {});
  await getSandboxRuntime()
    .startDevApp(id, databaseUrlFor(schema))
    .catch(() => {});
  // 容器内需 install + 启动，给一点时间后再探测
  await new Promise((r) => setTimeout(r, 1500));
  const st = await getSandboxRuntime()
    .devAppStatus(id)
    .catch(() => null);
  return c.json({ hasBackend: true, ready: st?.ready ?? false });
});

projectRoutes.get('/:id/devapp/status', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const st = await getSandboxRuntime()
    .devAppStatus(id)
    .catch(() => null);
  return c.json({ ready: st?.ready ?? false });
});
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

/** 发布：前端产物托管 + 每应用 Postgres schema + 常驻后端容器 */
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

  const rt = getSandboxRuntime();

  // 1) 前端产物托管（当前写本地目录，由前门 nginx 托管）
  const target = await publishFrontend(id, files);

  // 2) 判断是否含后端（apps/api）
  const listing = await signedJson<{ files: string[] }>(`/sandbox/${id}/files`, {
    method: 'GET',
  }).catch(() => ({ files: [] as string[] }));
  const hasBackend = listing.files.some((f) => f.startsWith('apps/api/'));

  // 3) 有后端：每应用一个 Postgres schema + 起常驻后端容器
  let schema: string | null = null;
  let status = 'running'; // 纯前端：托管完即可用
  if (hasBackend) {
    schema = await ensureAppSchema(id);
    try {
      await rt.stopRelease(id);
      await rt.startRelease(id, databaseUrlFor(schema));
      status = 'starting';
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('409') || msg.includes('release_limit')) {
        return c.json(
          { error: 'release_limit', message: '已发布应用数量已达上限，请先下架其他应用' },
          409,
        );
      }
      throw err;
    }
  }

  await query(
    `insert into app_releases (project_id, status, frontend_target, db_schema, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (project_id) do update set
       status = excluded.status, frontend_target = excluded.frontend_target,
       db_schema = excluded.db_schema, container_ip = null, container_port = null,
       error = null, updated_at = now()`,
    [id, status, target, schema],
  );

  return c.json({ status, url: `https://${id}.atoms.lexmin.cn` });
});

/** 发布状态（前端轮询直到 running） */
projectRoutes.get('/:id/deployment', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);

  const r = await query<{ status: string }>(
    'select status from app_releases where project_id = $1',
    [id],
  );
  const row = r.rows[0];
  if (!row) return c.json({ status: 'none' });

  if (row.status === 'starting') {
    const st = await getSandboxRuntime()
      .releaseStatus(id)
      .catch(() => null);
    if (st?.ready) {
      await query(
        `update app_releases
            set status = 'running', container_ip = $2, container_port = $3, updated_at = now()
          where project_id = $1`,
        [id, st.ip, config.releasePort],
      );
      return c.json({ status: 'running', url: `https://${id}.atoms.lexmin.cn` });
    }
  }
  return c.json({ status: row.status, url: `https://${id}.atoms.lexmin.cn` });
});

/** 下架：停容器、释放名额 */
projectRoutes.post('/:id/unpublish', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  await getSandboxRuntime()
    .stopRelease(id)
    .catch(() => {});
  await query(
    `update app_releases set status = 'stopped', container_ip = null, container_port = null, updated_at = now()
      where project_id = $1`,
    [id],
  );
  return c.json({ ok: true });
});
