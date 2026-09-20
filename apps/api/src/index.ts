import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { config, validateConfig } from './config';
import { originGuard } from './origin';
import { logErr } from './redact';
import { fail } from './respond';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { creditRoutes } from './routes/credits';
import { dbRoutes } from './routes/db';
import { projectRoutes } from './routes/projects';
import { skillRoutes } from './routes/skills';

validateConfig();

// 进程级兜底：
// - 未处理的 Promise 拒绝（例如流已断开时的写入、fire-and-forget 的落库）
//   只记日志、不退出：否则一次网络抖动就会让整个服务重启、打断所有进行中的请求。
// - 未捕获异常说明状态已不可信 → 记日志后退出，交给 pm2 立刻拉起（干净恢复）。
process.on('unhandledRejection', (reason) => {
  logErr('[api] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  logErr('[api] uncaughtException（进程将退出，pm2 会自动重启）:', err);
  process.exit(1);
});

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));

// 状态变更请求的显式来源校验（CSRF 纵深防御）
app.use('/api/*', originGuard);
app.route('/api/auth', authRoutes);
app.route('/api/credits', creditRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/projects', chatRoutes);
app.route('/api/projects', dbRoutes);
app.route('/api/skills', skillRoutes);

// 兜底：未匹配路由与未捕获异常都返回统一 JSON
// （默认实现是纯文本 "Internal Server Error"，前端只能显示 HTTP 500，且日志不过脱敏）
app.notFound((c) => c.json({ error: 'not_found', message: '接口不存在' }, 404));
app.onError((err, c) => fail(c, err));

serve({ fetch: app.fetch, port: config.apiPort, hostname: '127.0.0.1' }, (info) => {
  console.log(`[api] listening on http://127.0.0.1:${info.port}`);
});
