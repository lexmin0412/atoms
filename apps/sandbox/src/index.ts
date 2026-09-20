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
  docker,
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

/** 反代超时：后端卡死时不要一直挂着 */
const PROXY_TIMEOUT_MS = 60_000;

const app = new Hono<SandboxEnv>();

app.get('/health', async (c) => {
  // docker 挂了服务就是半死的：健康检查必须能反映出来（否则探活失真）
  try {
    await docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    return c.json(
      { ok: false, docker: false, message: 'docker 不可用，沙箱无法工作' },
      503,
    );
  }
  return c.json({ ok: true, docker: true });
});

/**
 * 未捕获异常 → 统一 JSON。
 * 运行时默认返回纯文本 "Internal Server Error"，A 侧无法解析、用户也看不到原因。
 */
app.onError((err, c) => {
  const code = (err as { code?: string })?.code;
  if (code === 'ENOENT') {
    return c.json({ error: 'not_found', message: '文件不存在' }, 404);
  }
  if (err instanceof SyntaxError || err.name === 'BadRequestError') {
    return c.json({ error: 'bad_request', message: '请求格式不正确' }, 400);
  }
  if (err.message === 'path escapes workspace') {
    return c.json({ error: 'invalid_path', message: '路径不合法' }, 400);
  }
  console.error('[sandbox] unhandled error:', err.message);
  return c.json({ error: 'sandbox_failed', message: '沙箱操作失败，请稍后重试' }, 500);
});
app.notFound((c) => c.json({ error: 'not_found', message: '接口不存在' }, 404));

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

/**
 * 预览还没构建时的兜底页。
 * 之前返回的是给开发者看的纯文本（"preview not built yet — 让 Agent 运行 pnpm -r build"），
 * 直接访问预览地址时会很难看，所以换成一张人看的提示页。
 */
const PREVIEW_EMPTY_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>暂无预览</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 14px/1.6 system-ui, -apple-system, "Noto Sans SC", sans-serif;
    color: #6b6b6b; background-color: #fafafa;
    background-image: linear-gradient(rgba(0,0,0,.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,0,0,.04) 1px, transparent 1px);
    background-size: 22px 22px; }
  .card { max-width: 34ch; padding: 24px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: #3a3a3a; }
  p { margin: 0; font-size: 12.5px; }
  @media (prefers-color-scheme: dark) {
    body { color: #8b8b8b; background-color: #121212;
      background-image: linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px); }
    h1 { color: #d4d4d4; }
  }
</style></head>
<body><div class="card">
  <h1>还没有预览</h1>
  <p>这个应用还没构建出产物。让 Agent 生成并构建成功后，这里会自动显示。</p>
</div></body></html>`;

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
    return new Response(PREVIEW_EMPTY_HTML, {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
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
  await stopRelease(c.req.param('id')).catch(() => {});
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
  let res: Response;
  try {
    res = await fetch(target, { ...init, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  } catch {
    // 容器在跑但后端已死 / 端口未就绪：给可重试的 503（不回传内部地址）
    return c.json(
      { error: 'release_unreachable', message: '应用后端暂时无响应，请稍后重试' },
      503,
    );
  }
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
  let res: Response;
  try {
    res = await fetch(full, { ...init, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  } catch {
    // 容器刚退出 / 端口未就绪：给出可操作的 503，而不是 500
    // 注意：不回传 detail —— 该路径对公网开放，原始错误含容器内网地址
    return c.json(
      {
        error: 'devapp_unreachable',
        message: '开发预览后端未运行。请在项目页面点「重新构建」后再试。',
      },
      503,
    );
  }
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
