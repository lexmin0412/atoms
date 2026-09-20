import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';

import type { SessionUser } from '../auth';
import {
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  currentUser,
} from '../auth';
import { ensureGrant } from '../credits';
import { query } from '../db';
import { checkLimit, clearFailures, clientIp, recordFailure } from '../ratelimit';
import { logErr } from '../redact';

export type Env = { Variables: { user: SessionUser } };

export const authRoutes = new Hono<Env>();

const PASSWORD_MIN = 10;
/** 常见弱口令（小样本即可挡掉绝大多数撞库尝试） */
const WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '1234567890',
  '12345678901',
  'qwertyuiop',
  '1111111111',
  'aaaaaaaaaa',
  'admin12345',
  'letmein123',
  'iloveyou12',
  'welcome123',
]);

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, 'too_short')
  .max(100)
  .refine((p) => !WEAK_PASSWORDS.has(p.toLowerCase()), 'too_weak')
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'too_simple');

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(1).max(50),
  password: passwordSchema,
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    const pw = parsed.error.issues.find((i) => i.path[0] === 'password')?.message;
    return c.json(
      {
        error:
          pw === 'too_short'
            ? 'password_too_short'
            : pw
              ? 'password_too_weak'
              : 'invalid_input',
        message:
          pw === 'too_short'
            ? `密码至少 ${PASSWORD_MIN} 位`
            : pw
              ? '密码过于简单，请包含字母与数字且避免常见口令'
              : '输入不合法',
      },
      400,
    );
  }
  const { email, username, password } = parsed.data;

  // 限流：按 IP（防批量注册）+ 按邮箱（防针对账号）
  const ip = clientIp(c.req.raw.headers);
  for (const key of [`reg:ip:${ip}`, `reg:acct:${email}`]) {
    const lim = checkLimit(key);
    if (!lim.ok) {
      return c.json(
        { error: 'too_many_requests', message: '尝试过于频繁，请稍后再试' },
        429,
        { 'Retry-After': String(lim.retryAfterSec ?? 60) },
      );
    }
  }

  const exists = await query('select 1 from users where email = $1', [email]);
  if (exists.rowCount) {
    recordFailure(`reg:ip:${ip}`);
    return c.json({ error: 'email_taken', message: '该邮箱已被注册' }, 409);
  }

  const r = await query<SessionUser>(
    `insert into users (email, username, password_hash)
     values ($1, $2, $3)
     returning id, email, username`,
    [email, username, hashPassword(password)],
  );
  const user = r.rows[0];
  // 新用户：开通 credits 账户并发放首期额度（失败不影响注册）
  await ensureGrant(user.id).catch((err) => logErr('[auth] 初始化 credits 失败:', err));
  const token = await createSession(user.id);
  setSessionCookie(c, token);
  return c.json({ user });
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const { email, password } = parsed.data;

  const ip = clientIp(c.req.raw.headers);
  const ipKey = `login:ip:${ip}`;
  const acctKey = `login:acct:${email}`;
  for (const key of [ipKey, acctKey]) {
    const lim = checkLimit(key);
    if (!lim.ok) {
      return c.json(
        { error: 'too_many_requests', message: '尝试过于频繁，请稍后再试' },
        429,
        { 'Retry-After': String(lim.retryAfterSec ?? 60) },
      );
    }
  }

  const r = await query<SessionUser & { password_hash: string }>(
    'select id, email, username, password_hash from users where email = $1',
    [email],
  );
  const row = r.rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    recordFailure(ipKey);
    recordFailure(acctKey);
    // 统一模糊报错：不区分「账号不存在」与「密码错误」
    return c.json({ error: 'invalid_credentials', message: '邮箱或密码不正确' }, 401);
  }
  clearFailures(ipKey);
  clearFailures(acctKey);
  const token = await createSession(row.id);
  setSessionCookie(c, token);
  return c.json({ user: { id: row.id, email: row.email, username: row.username } });
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, 'atoms_session');
  if (token) {
    await query('delete from sessions where token = $1', [token]).catch(() => {});
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ user });
});
