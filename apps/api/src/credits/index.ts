import type { PoolClient } from 'pg';

import { config } from '../config';
import { pool, query } from '../db';
import { roundCredits } from './pricing';

/** 当前自然月（UTC），如 `2026-09` */
export function currentPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface Account {
  userId: string;
  balance: number;
  grantedPeriod: string | null;
}

interface LedgerExtra {
  projectId?: string | null;
  ref?: string | null;
  meta?: Record<string, unknown>;
}

async function writeLedger(
  client: PoolClient,
  userId: string,
  delta: number,
  balanceAfter: number,
  reason: 'grant' | 'usage' | 'adjust',
  extra: LedgerExtra = {},
) {
  await client.query(
    `insert into credit_ledger (user_id, delta, balance_after, reason, project_id, ref, meta)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      delta,
      balanceAfter,
      reason,
      extra.projectId ?? null,
      extra.ref ?? null,
      JSON.stringify(extra.meta ?? {}),
    ],
  );
}

/** 在一个事务里拿账户行锁（不存在则创建），保证扣减/发放不并发错乱 */
async function withAccount<T>(
  userId: string,
  fn: (client: PoolClient, account: Account) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into credit_accounts (user_id, balance, granted_period)
       values ($1, 0, null) on conflict (user_id) do nothing`,
      [userId],
    );
    const r = await client.query<{
      user_id: string;
      balance: string;
      granted_period: string | null;
    }>(
      'select user_id, balance, granted_period from credit_accounts where user_id = $1 for update',
      [userId],
    );
    const row = r.rows[0];
    const account: Account = {
      userId: row.user_id,
      balance: Number(row.balance),
      grantedPeriod: row.granted_period,
    };
    const out = await fn(client, account);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 周期发放：若本周期未发放，补满到 `CREDITS_MONTHLY_GRANT`。
 * 余额高于额度时不回退（只记 period）。返回最新余额。
 */
export async function ensureGrant(
  userId: string,
  period = currentPeriod(),
): Promise<number> {
  return withAccount(userId, async (client, account) => {
    if (account.grantedPeriod === period) return account.balance;
    const target = config.creditsMonthlyGrant;
    const delta = roundCredits(Math.max(0, target - account.balance));
    const balance = roundCredits(account.balance + delta);
    await client.query(
      'update credit_accounts set balance = $1, granted_period = $2, updated_at = now() where user_id = $3',
      [balance, period, userId],
    );
    if (delta > 0) {
      await writeLedger(client, userId, delta, balance, 'grant', { meta: { period } });
    }
    return balance;
  });
}

/** 只读余额（不触发放）。用于展示；调用方一般先 ensureGrant */
export async function getBalance(userId: string): Promise<number> {
  const r = await query<{ balance: string }>(
    'select balance from credit_accounts where user_id = $1',
    [userId],
  );
  return r.rowCount ? Number(r.rows[0].balance) : 0;
}

/** 生成消耗：按实际用量扣减（允许扣成负） */
export async function spend(
  userId: string,
  credits: number,
  extra: LedgerExtra = {},
): Promise<number> {
  const amount = roundCredits(credits);
  if (!(amount > 0)) return getBalance(userId);
  return withAccount(userId, async (client, account) => {
    const balance = roundCredits(account.balance - amount);
    await client.query(
      'update credit_accounts set balance = $1, updated_at = now() where user_id = $2',
      [balance, userId],
    );
    await writeLedger(client, userId, -amount, balance, 'usage', extra);
    return balance;
  });
}

/** 管理员手动调整（正数加、负数减） */
export async function adjust(
  userId: string,
  delta: number,
  note: string,
  actor: string,
): Promise<number> {
  const amount = roundCredits(delta);
  if (!amount) return getBalance(userId);
  return withAccount(userId, async (client, account) => {
    const balance = roundCredits(account.balance + amount);
    await client.query(
      'update credit_accounts set balance = $1, updated_at = now() where user_id = $2',
      [balance, userId],
    );
    await writeLedger(client, userId, amount, balance, 'adjust', {
      meta: { note, actor },
    });
    return balance;
  });
}

export interface LedgerRow {
  id: string;
  delta: string;
  balance_after: string;
  reason: string;
  project_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export async function listLedger(
  userId: string,
  opts: { page?: number; pageSize?: number; projectId?: string } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (opts.projectId) {
    params.push(opts.projectId);
    where += ` and project_id = $${params.length}`;
  }
  const total = await query<{ n: string }>(
    `select count(*)::text as n from credit_ledger where ${where}`,
    params,
  );
  const rows = await query<LedgerRow>(
    `select id, delta, balance_after, reason, project_id, meta, created_at
       from credit_ledger where ${where}
      order by created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows: rows.rows, total: Number(total.rows[0]?.n ?? 0), page, pageSize };
}

/** 本周期已消耗（用于「本月已用 X」展示） */
export async function spentThisPeriod(
  userId: string,
  period = currentPeriod(),
): Promise<number> {
  const r = await query<{ n: string }>(
    `select coalesce(-sum(delta), 0)::text as n from credit_ledger
      where user_id = $1 and reason = 'usage'
        and to_char(created_at at time zone 'UTC', 'YYYY-MM') = $2`,
    [userId, period],
  );
  return roundCredits(Number(r.rows[0]?.n ?? 0));
}

/**
 * db:init 种子：给尚无账户的历史用户补初始额度。
 * 返回 { users }。
 */
export async function bootstrapCredits(): Promise<{ users: number }> {
  const users = await query<{ id: string }>('select id from users');
  let n = 0;
  for (const u of users.rows) {
    const has = await query('select 1 from credit_accounts where user_id = $1', [u.id]);
    if (has.rowCount) continue;
    await ensureGrant(u.id);
    n += 1;
  }
  return { users: n };
}
