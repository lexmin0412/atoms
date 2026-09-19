import { Hono } from 'hono';

import { requireUser } from '../auth';
import { config } from '../config';
import { currentPeriod, ensureGrant, listLedger, spentThisPeriod } from '../credits';
import type { Env } from './auth';

export const creditRoutes = new Hono<Env>();

creditRoutes.use('*', requireUser);

/** 余额 + 本周期用量（顺带触发周期发放） */
creditRoutes.get('/', async (c) => {
  const user = c.get('user');
  const balance = await ensureGrant(user.id);
  const period = currentPeriod();
  const spent = await spentThisPeriod(user.id, period);
  return c.json({
    balance,
    spent,
    monthlyGrant: config.creditsMonthlyGrant,
    period,
  });
});

/** 消耗明细（分页，可按项目筛选） */
creditRoutes.get('/ledger', async (c) => {
  const user = c.get('user');
  const page = Number(c.req.query('page') ?? '1') || 1;
  const projectId = c.req.query('projectId') || undefined;
  const r = await listLedger(user.id, { page, pageSize: 20, projectId });
  return c.json(r);
});
