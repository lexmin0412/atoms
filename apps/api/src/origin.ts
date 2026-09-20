import type { Context, Next } from 'hono';

import { config } from './config';

/**
 * CSRF 纵深防御：状态变更请求若带了 Origin，必须来自我们自己的站点。
 *
 * - 当前已靠「只接受 JSON（非简单请求）+ 未开 CORS」挡住了绝大多数 CSRF；
 *   这里把隐式保护变成**显式校验**，避免日后加了 CORS 或接受表单时失守。
 * - 不带 Origin 的请求（curl / CLI / 服务端调用）放行 —— 浏览器发起跨站请求一定会带 Origin。
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function allowedOrigins(): string[] {
  const list = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
  ];
  if (config.appsDomain) list.push(`https://${config.appsDomain}`);
  return list;
}

export async function originGuard(c: Context, next: Next) {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const origin = c.req.header('origin');
  if (origin && !allowedOrigins().includes(origin)) {
    return c.json({ error: 'forbidden_origin', message: '请求来源不被允许' }, 403);
  }
  // 现代浏览器还会带 Sec-Fetch-Site；跨站时是 cross-site
  const site = c.req.header('sec-fetch-site');
  if (site && site === 'cross-site') {
    return c.json({ error: 'forbidden_origin', message: '请求来源不被允许' }, 403);
  }
  return next();
}
