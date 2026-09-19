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
  if (!config.secret) return c.json({ error: 'server_misconfigured' }, 500);

  const ts = c.req.header('x-atoms-ts') ?? '';
  const sig = c.req.header('x-atoms-sig') ?? '';
  if (!ts || !sig) return c.json({ error: 'unauthorized' }, 401);

  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) {
    return c.json({ error: 'expired' }, 401);
  }

  const url = new URL(c.req.url);
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
