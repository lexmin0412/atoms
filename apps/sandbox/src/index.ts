import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { hmacAuth, type SandboxEnv } from './auth';
import { config } from './config';
import { touch, forget, startReaper } from './lifecycle';
import {
  ensureSandbox,
  destroySandbox,
  execStream,
  isSandboxRunning,
  readWsFile,
  writeWsFile,
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
  const { sandboxId } = body<{ sandboxId?: string }>(c);
  if (!sandboxId) return c.json({ error: 'sandboxId_required' }, 400);

  // 并发闸门：超出上限则拒绝（避免 2C4G 被撑爆）
  const running = await listRunningSandboxIds();
  if (running.length >= config.maxSandboxes && !running.includes(sandboxId)) {
    return c.json(
      { error: 'busy', running: running.length, max: config.maxSandboxes },
      429,
    );
  }

  await ensureSandbox(sandboxId);
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
  await destroySandbox(c.req.param('id'));
  forget(c.req.param('id'));
  return c.json({ ok: true });
});

startReaper().catch((err) => console.error('[reaper] start failed:', err));

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[sandbox] listening on http://${config.host}:${info.port}`);
});
