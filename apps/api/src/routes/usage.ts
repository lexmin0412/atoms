import { Hono } from 'hono';

import { requireUser } from '../auth';
import { config } from '../config';
import type { Env } from './auth';

export const usageRoutes = new Hono<Env>();

usageRoutes.use('*', requireUser);

/** 系统额度：转发 OpenCode Go 的配额接口（展示用，非精确计量） */
usageRoutes.get('/', async (c) => {
  try {
    const res = await fetch(`${config.llm.baseUrl}/usage`, {
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        'User-Agent': 'atoms-demo/1.0',
      },
    });
    if (!res.ok) {
      return c.json({ error: 'upstream_error', status: res.status }, 502);
    }
    return c.json(await res.json());
  } catch {
    return c.json({ error: 'fetch_failed' }, 502);
  }
});
