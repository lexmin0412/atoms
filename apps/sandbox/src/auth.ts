import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

import type { Context, Next } from 'hono';

import { config } from './config';

const MAX_SKEW_MS = 60_000;

export type SandboxEnv = { Variables: { rawBody: string } };

export function sign(
  secret: string,
  ts: string,
  method: string,
  pathWithQuery: string,
  body: string,
) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret)
    .update(`${ts}\n${method}\n${pathWithQuery}\n${bodyHash}`)
    .digest('hex');
}

export async function hmacAuth(c: Context<SandboxEnv>, next: Next) {
  // 已发布应用的后端反代（/sandbox/:id/app/*）对公网开放，无需 HMAC；
  // 且沙箱服务仅监听 127.0.0.1（经 A 机隧道访问），不对外暴露。
  const url = new URL(c.req.url);
  if (
    /^\/sandbox\/[^/]+\/(app|devapp)(\/|$)/.test(url.pathname) ||
    /^\/sandbox\/[^/]+\/preview(\/|$)/.test(url.pathname)
  ) {
    // 豁免鉴权（这些路径经前门对公网开放，用于反代）。注意：不在此消费 body，
    // 否则下游代理无法再次读取。
    await next();
    return;
  }

  if (!config.secret) return c.json({ error: 'server_misconfigured' }, 500);

  const ts = c.req.header('x-atoms-ts') ?? '';
  const sig = c.req.header('x-atoms-sig') ?? '';
  if (!ts || !sig) return c.json({ error: 'unauthorized' }, 401);

  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) {
    return c.json({ error: 'expired' }, 401);
  }

  const pathWithQuery = url.pathname + url.search;
  const body = await c.req.text();
  const expected = sign(config.secret, ts, c.req.method, pathWithQuery, body);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  c.set('rawBody', body);
  await next();
}
