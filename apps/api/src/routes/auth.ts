import { Hono } from 'hono';
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
import { query } from '../db';

export type Env = { Variables: { user: SessionUser } };

export const authRoutes = new Hono<Env>();

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(1).max(50),
  password: z.string().min(6).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const { email, username, password } = parsed.data;

  const exists = await query('select 1 from users where email = $1', [email]);
  if (exists.rowCount) return c.json({ error: 'email_taken' }, 409);

  const r = await query<SessionUser>(
    `insert into users (email, username, password_hash)
     values ($1, $2, $3)
     returning id, email, username`,
    [email, username, hashPassword(password)],
  );
  const user = r.rows[0];
  const token = await createSession(user.id);
  setSessionCookie(c, token);
  return c.json({ user });
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const { email, password } = parsed.data;

  const r = await query<SessionUser & { password_hash: string }>(
    'select id, email, username, password_hash from users where email = $1',
    [email],
  );
  const row = r.rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const token = await createSession(row.id);
  setSessionCookie(c, token);
  return c.json({ user: { id: row.id, email: row.email, username: row.username } });
});

authRoutes.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ user });
});
