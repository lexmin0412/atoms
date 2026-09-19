import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';

import { hmacAuth, type SandboxEnv } from './auth';
import { config } from './config';
import { touch, forget, startReaper } from './lifecycle';
import {
  startRelease,
  stopRelease,
  releaseStatus,
  releaseReady,
  listReleaseIds,
  startDevApp,
  stopDevApp,
  devAppReady,
  devAppTarget,
} from './release';
import {
  ensureSandbox,
  destroySandbox,
  execStream,
  isSandboxRunning,
  readWsFile,
  writeWsFile,
  removeWsPath,
  listWsFiles,
  snapshotWorkspace,
  readDistFile,
  distVersion,
  snapshotDist,
  listRunningSandboxIds,
} from './workspace';

const app = new Hono<SandboxEnv>();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/sandbox/*', hmacAuth);
app.use('/sandbox', hmacAuth);

// 记录活跃时间（供回收器判断空闲）
app.use('/sandbox/:id', async (c, next) => {
  touch(c.req.param('id'));
  await next();
});
app.use('/sandbox/:id/*', async (c, next) => {
  touch(c.req.param('id'));
  await next();
});

function body<T>(c: { get: (k: 'rawBody') => string }): T {
  const raw = c.get('rawBody');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

app.post('/sandbox', async (c) => {
  const { sandboxId, databaseUrl } = body<{ sandboxId?: string; databaseUrl?: string }>(
    c,
  );
  if (!sandboxId) return c.json({ error: 'sandboxId_required' }, 400);

  // 并发闸门：超出上限则拒绝（避免 2C4G 被撑爆）
  const running = await listRunningSandboxIds();
  if (running.length >= config.maxSandboxes && !running.includes(sandboxId)) {
    return c.json(
      { error: 'busy', running: running.length, max: config.maxSandboxes },
      429,
    );
  }

  await ensureSandbox(sandboxId, databaseUrl);
  touch(sandboxId);
  return c.json({ id: sandboxId, running: await isSandboxRunning(sandboxId) });
});

app.get('/sandbox/:id/status', async (c) => {
  return c.json({ running: await isSandboxRunning(c.req.param('id')) });
});

app.post('/sandbox/:id/exec', async (c) => {
  const id = c.req.param('id');
  const { cmd } = body<{ cmd?: string }>(c);
  if (!cmd) return c.json({ error: 'cmd_required' }, 400);
  await ensureSandbox(id);
  const stream = execStream(id, cmd);
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

app.get('/sandbox/:id/file', async (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path_required' }, 400);
  const content = await readWsFile(c.req.param('id'), path);
  return c.json({ path, content });
});

app.put('/sandbox/:id/file', async (c) => {
  const { path, content } = body<{ path?: string; content?: string }>(c);
  if (!path) return c.json({ error: 'path_required' }, 400);
  await writeWsFile(c.req.param('id'), path, content ?? '');
  return c.json({ ok: true });
});

app.delete('/sandbox/:id/file', async (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path_required' }, 400);
  await removeWsPath(c.req.param('id'), path);
  return c.json({ ok: true });
});

app.get('/sandbox/:id/files', async (c) => {
  return c.json({ files: await listWsFiles(c.req.param('id')) });
});

app.post('/sandbox/:id/snapshot', async (c) => {
  return c.json({ files: await snapshotWorkspace(c.req.param('id')) });
});

// 预览：静态托管 apps/web/dist
async function servePreview(c: { req: { param: (k: string) => string; url: string } }) {
  const id = c.req.param('id');
  const url = new URL(c.req.url);
  const prefix = `/sandbox/${id}/preview/`;
  const rel = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  try {
    const { buffer, contentType } = await readDistFile(id, rel || 'index.html');
    return new Response(buffer, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('preview not built yet — 让 Agent 运行 pnpm -r build', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

app.get('/sandbox/:id/preview', servePreview);
app.get('/sandbox/:id/preview/*', servePreview);

app.get('/sandbox/:id/preview-version', async (c) => {
  return c.json({ version: await distVersion(c.req.param('id')) });
});

app.post('/sandbox/:id/dist-snapshot', async (c) => {
  return c.json({ files: await snapshotDist(c.req.param('id')) });
});

app.delete('/sandbox/:id', async (c) => {
  await stopDevApp(c.req.param('id')).catch(() => {});
  await destroySandbox(c.req.param('id'));
  forget(c.req.param('id'));
  return c.json({ ok: true });
});

// ---- 已发布应用：常驻后端容器 + 反代 ----

app.post('/sandbox/:id/release', async (c) => {
  const id = c.req.param('id');
  const { databaseUrl } = body<{ databaseUrl?: string }>(c);
  const running = await listReleaseIds();
  if (running.length >= config.maxReleases && !running.includes(id)) {
    return c.json({ error: 'release_limit', max: config.maxReleases }, 409);
  }
  await startRelease(id, databaseUrl ?? '');
  return c.json({ status: 'starting' });
});

app.get('/sandbox/:id/release/status', async (c) => {
  return c.json(await releaseReady(c.req.param('id') ?? ''));
});

app.post('/sandbox/:id/release/stop', async (c) => {
  await stopRelease(c.req.param('id'));
  return c.json({ ok: true });
});

/** 前门 <id>.<APPS_DOMAIN>/api/* → 该应用常驻后端容器 */
async function appProxy(c: Context<SandboxEnv>) {
  const id = c.req.param('id') ?? '';
  const st = await releaseStatus(id);
  if (!st.running || !st.ip) return c.json({ error: 'not_running' }, 503);

  const url = new URL(c.req.url);
  const prefix = `/sandbox/${id}/app/`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const target = `http://${st.ip}:${config.releasePort}/${rest}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');
  headers.delete('x-atoms-ts');
  headers.delete('x-atoms-sig');
  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = await c.req.arrayBuffer();
  }
  const res = await fetch(target, init);
  const out = new Headers(res.headers);
  out.delete('content-encoding');
  out.delete('content-length');
  out.delete('transfer-encoding');
  return new Response(res.body, { status: res.status, headers: out });
}

app.all('/sandbox/:id/app', appProxy);
app.all('/sandbox/:id/app/*', appProxy);

// ---- 开发预览：在开发沙箱容器内跑应用后端，供 dev-<id> 子域反代 ----

app.post('/sandbox/:id/devapp', async (c) => {
  const id = c.req.param('id') ?? '';
  // 该路径豁免 HMAC，rawBody 未设置，直接读 body
  const parsed = (await c.req.json().catch(() => ({}))) as { databaseUrl?: string };
  await startDevApp(id, parsed.databaseUrl ?? '');
  return c.json({ status: 'starting' });
});

/** 强制重启开发应用后端（加载最新源码） */
app.post('/sandbox/:id/devapp/restart', async (c) => {
  const id = c.req.param('id') ?? '';
  const parsed = (await c.req.json().catch(() => ({}))) as { databaseUrl?: string };
  await startDevApp(id, parsed.databaseUrl ?? '', true);
  return c.json({ status: 'restarting' });
});

app.get('/sandbox/:id/devapp/status', async (c) => {
  return c.json(await devAppReady(c.req.param('id') ?? ''));
});

async function devAppProxy(c: Context<SandboxEnv>) {
  const id = c.req.param('id') ?? '';
  const target = await devAppTarget(id);
  if (!target) return c.json({ error: 'not_running' }, 503);

  const url = new URL(c.req.url);
  const prefix = `/sandbox/${id}/devapp/`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const full = `${target}/${rest}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');
  headers.delete('x-atoms-ts');
  headers.delete('x-atoms-sig');
  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = await c.req.arrayBuffer();
  }
  const res = await fetch(full, init);
  const out = new Headers(res.headers);
  out.delete('content-encoding');
  out.delete('content-length');
  out.delete('transfer-encoding');
  return new Response(res.body, { status: res.status, headers: out });
}

app.all('/sandbox/:id/devapp', devAppProxy);
app.all('/sandbox/:id/devapp/*', devAppProxy);

startReaper().catch((err) => console.error('[reaper] start failed:', err));

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[sandbox] listening on http://${config.host}:${info.port}`);
});
