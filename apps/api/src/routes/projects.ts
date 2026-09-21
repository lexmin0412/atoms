import type { UIMessage } from 'ai';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { isBusy } from '../agent-busy';
import { requireUser } from '../auth';
import { COMPRESS_RATIO } from '../compress';
import { config } from '../config';
import { repairHistory } from '../context';
import { getModelInfo } from '../credits/pricing';
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
import { logErr } from '../redact';
import { ensureAppSchema, ensureDevSchema, databaseUrlFor } from '../release/db';
import { publishFrontend } from '../release/frontend';
import { fail } from '../respond';
import { getRuntime, getSandboxRuntime } from '../runtime';
import { SandboxError, signedFetch, signedJson } from '../runtime/http';
import { destroyWorkspace, acquireWorkspace, withWorkspace } from '../runtime/manager';
import type { Env } from './auth';

export const projectRoutes = new Hono<Env>();

projectRoutes.use('*', requireUser);

const createSchema = z.object({ title: z.string().min(1).max(120) });

/** 打开项目时愿意为「恢复工作区」等待的上限；超时且盘上已有源码就先启动预览 */
const WORKSPACE_WAIT_MS = 20_000;

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

/** 已发布应用 URL（未配置 APPS_DOMAIN 时返回空串，前端自行降级） */
function publishedUrl(id: string): string {
  return config.appsDomain ? `https://${id}.${config.appsDomain}` : '';
}
/** 开发预览 URL */
function previewUrl(id: string): string {
  return config.appsDomain ? `https://dev-${id}.${config.appsDomain}/` : '';
}

projectRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const project = await ownedProject(c.req.param('id'), user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  return c.json({ project });
});

/** 每项目的 Agent 设置：最大步数（用户可配）+ 模型上下文窗口（给前端算上下文用量） */
const MAX_STEPS_MIN = 100;
const MAX_STEPS_MAX = 1000;
const DEFAULT_MAX_STEPS = 500;

projectRoutes.get('/:id/agent', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const r = await query<{
    max_steps: number;
    context_summary_count: number;
    last_input_tokens: number | null;
  }>(
    'select max_steps, context_summary_count, last_input_tokens from projects where id = $1 and user_id = $2',
    [id, user.id],
  );
  if (!r.rowCount)
    return c.json({ error: 'not_found', message: '项目不存在或无权访问' }, 404);
  const info = await getModelInfo(config.llm.model);
  return c.json({
    maxSteps: r.rows[0].max_steps,
    defaultMaxSteps: DEFAULT_MAX_STEPS,
    minSteps: MAX_STEPS_MIN,
    maxStepsLimit: MAX_STEPS_MAX,
    model: config.llm.model,
    contextLimit: info.contextLimit,
    contextLimitKnown: info.known,
    // 上下文压缩：软上限 / 触发阈值 / 已压缩条数 / 上轮真实输入
    contextSoftLimit: config.contextSoftLimit,
    compressAt: Math.round(config.contextSoftLimit * COMPRESS_RATIO),
    compressedCount: r.rows[0].context_summary_count,
    lastInputTokens: r.rows[0].last_input_tokens,
  });
});

projectRoutes.patch('/:id/agent', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req
    .json<{ maxSteps?: unknown }>()
    .catch(() => ({}) as { maxSteps?: unknown });
  const maxSteps = Number(body.maxSteps);
  if (
    !Number.isInteger(maxSteps) ||
    maxSteps < MAX_STEPS_MIN ||
    maxSteps > MAX_STEPS_MAX
  ) {
    return c.json(
      {
        error: 'invalid_input',
        message: `最大步数需为 ${MAX_STEPS_MIN}~${MAX_STEPS_MAX} 之间的整数`,
      },
      400,
    );
  }
  const r = await query(
    'update projects set max_steps = $1, updated_at = now() where id = $2 and user_id = $3 returning max_steps',
    [maxSteps, id, user.id],
  );
  if (!r.rowCount)
    return c.json({ error: 'not_found', message: '项目不存在或无权访问' }, 404);
  return c.json({ maxSteps });
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
  const r = await query<{
    id: string;
    seq: number;
    role: string;
    parts: unknown;
    created_at: string;
  }>(
    'select id, seq, role, parts, created_at from messages where project_id = $1 order by seq asc',
    [c.req.param('id')],
  );
  // 被中断的悬空工具调用在这里也修一遍：否则前端工具卡会一直停在「运行中」
  const repaired = repairHistory(
    r.rows.map((row) => ({ role: row.role, parts: row.parts }) as unknown as UIMessage),
  );
  return c.json({
    messages: r.rows.map((row, i) => ({
      ...row,
      parts: repaired[i]?.parts ?? row.parts,
    })),
  });
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
  // 未知异常：原始 message 可能带沙箱内部路径/上游报文，只落日志
  return fail(c, err);
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
        // 构建失败通常是用户代码问题 → 422；日志是用户自己的构建输出，可回传
        return c.json(
          {
            error: 'build_failed',
            message: '构建未通过，请查看构建日志',
            log: log.join('').slice(-4000),
          },
          422,
        );
      }
    }
    const listing = await signedJson<{ files: string[] }>(`/sandbox/${id}/files`, {
      method: 'GET',
    }).catch(() => ({ files: [] as string[] }));
    if (listing.files.some((f) => f.startsWith('apps/api/'))) {
      await rt.restartDevApp(id, await databaseUrlFor(schema));
    }
    return c.json({ ok: true, log: log.join('').slice(-4000) });
  } catch (err) {
    if (err instanceof SandboxError) return fail(c, err);
    logErr('[rebuild] error:', err);
    return c.json(
      {
        error: 'build_failed',
        message: '构建环境出错，请稍后重试',
        log: log.join('').slice(-4000),
      },
      500,
    );
  }
});

/** 应用图标：Agent 生成的 apps/web/public/icon.svg（首页卡片展示） */
projectRoutes.get('/:id/icon', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  const file = await readFile(id, 'apps/web/public/icon.svg').catch(() => null);
  if (!file || !file.content.trim()) return c.json({ error: 'not_found' }, 404);
  return new Response(file.content, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=60',
      // 用户可控内容：禁止嗅探、禁止脚本执行、禁止被当作文档内联渲染
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': 'attachment; filename="icon.svg"',
    },
  });
});

projectRoutes.get('/:id/preview-url', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  return c.json({ url: previewUrl(id) });
});

/** 启动开发应用后端（供预览子域的 /api 使用）；纯前端项目可忽略 */
projectRoutes.post('/:id/devapp', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);

  // 仅在项目含 apps/api 时启动
  let hasBackend: boolean;
  let workspaceHasFiles: boolean;
  try {
    const listing = await signedJson<{ files: string[] }>(`/sandbox/${id}/files`, {
      method: 'GET',
    });
    hasBackend = listing.files.some((f) => f.startsWith('apps/api/'));
    workspaceHasFiles = listing.files.length > 0;
  } catch (err) {
    // 探测失败时绝不能当成“纯前端”，否则含后端的应用会被发成残废版本
    return fail(c, err);
  }
  if (!hasBackend) return c.json({ hasBackend: false, ready: true });

  const schema = await ensureDevSchema(id);
  // 先确保开发沙箱存在（可能已被空闲回收）。整仓恢复要逐个写回数千个文件，
  // 这里只等一小段：若超时且沙箱盘上已有源码，就先让预览可用、同步在后台继续
  // （DB 仍是唯一事实源，用户点「重新构建」会再对齐一次）。
  let warmErr: unknown = null;
  const warm = await Promise.race([
    acquireWorkspace(id)
      .then(() => 'ok' as const)
      .catch((err: unknown) => {
        warmErr = err;
        return 'err' as const;
      }),
    new Promise<'slow'>((r) => setTimeout(() => r('slow'), WORKSPACE_WAIT_MS)),
  ]);
  if (warm === 'err') return fail(c, warmErr);
  if (warm === 'slow') {
    if (!workspaceHasFiles)
      return fail(
        c,
        new SandboxError(503, 'sandbox_unreachable', '运行环境暂时不可用，请稍后重试'),
      );
    logErr('[devapp] 工作区同步较慢，先启动预览后端:', id);
  }
  try {
    await getSandboxRuntime().startDevApp(id, await databaseUrlFor(schema));
  } catch (err) {
    return fail(c, err);
  }
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

  let snap: { files: Record<string, string> };
  try {
    snap = await signedJson<{ files: Record<string, string> }>(
      `/sandbox/${id}/dist-snapshot`,
      { method: 'POST' },
    );
  } catch (err) {
    // 沙箱不可达 ≠ 没构建过：不能误导用户去重新构建
    return fail(c, err);
  }
  const files = snap.files ?? {};
  if (Object.keys(files).length === 0) {
    return c.json(
      { error: 'not_built', message: '还没有可发布的构建产物，请先让 Agent 构建成功' },
      400,
    );
  }

  const rt = getSandboxRuntime();

  // 是否首次发布（用于前端给出准确文案：首次要装依赖，后续快很多）
  const prior = await query('select 1 from app_releases where project_id = $1', [id]);
  const firstTime = !prior.rowCount;

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
      await rt.startRelease(id, await databaseUrlFor(schema));
      status = 'starting';
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('409') || msg.includes('release_limit')) {
        return c.json(
          { error: 'release_limit', message: '已发布应用数量已达上限，请先下架其他应用' },
          409,
        );
      }
      return fail(c, err);
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

  return c.json({ status, url: publishedUrl(id), firstTime });
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
      return c.json({ status: 'running', url: publishedUrl(id) });
    }
    // 容器确实没在跑 → 发布失败，别再让前端无限轮询
    if (st && !st.running) {
      const message = '发布容器未能启动，请重新发布';
      await query(
        `update app_releases set status = 'error', error = $2, updated_at = now()
          where project_id = $1`,
        [id, message],
      );
      return c.json({ status: 'error', message, url: publishedUrl(id) });
    }
  }
  return c.json({ status: row.status, url: publishedUrl(id) });
});

/** 下架：停容器、释放名额 */
projectRoutes.post('/:id/unpublish', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id_required' }, 400);
  const project = await ownedProject(id, user.id);
  if (!project) return c.json({ error: 'not_found' }, 404);
  try {
    await getSandboxRuntime().stopRelease(id);
  } catch (err) {
    return fail(c, err);
  }
  await query(
    `update app_releases set status = 'stopped', container_ip = null, container_port = null, updated_at = now()
      where project_id = $1`,
    [id],
  );
  return c.json({ ok: true });
});
