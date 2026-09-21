import { Hono } from 'hono';

import type { Env } from './auth';

/**
 * 客户端诊断上报（只记日志，不落库）。
 *
 * 背景：线上出现「页面侧连接在几秒后被断开、回复半截」，服务端只能看到
 * `@hono/node-server` 给出的 "Client connection prematurely closed."，
 * 分不清是浏览器主动取消、标签页被切到后台、还是链路断了。
 * 前端在流失败时把本地视角（错误名/文案、可见性、在线状态、UA、已收字节）报上来，
 * 与服务端日志对齐即可定位。默认只打日志，不收集任何业务内容。
 */
export const diagRoutes = new Hono<Env>();

diagRoutes.post('/client', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const clip = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : v);
  console.log(
    '[diag] 客户端上报:',
    JSON.stringify({
      ...body,
      errorName: clip(body?.errorName),
      errorMessage: clip(body?.errorMessage),
      ua: clip(body?.ua, 200),
      url: clip(body?.url, 200),
      at: new Date().toISOString(),
    }),
  );
  return c.json({ ok: true });
});
