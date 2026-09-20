import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import { query } from './db';

const COOKIE = 'atoms_session';
const IS_PROD = process.env.NODE_ENV === 'production';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(pw, salt, 64);
  const original = Buffer.from(hash, 'hex');
  return candidate.length === original.length && timingSafeEqual(candidate, original);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await query('insert into sessions (user_id, token, expires_at) values ($1, $2, $3)', [
    userId,
    token,
    expires,
  ]);
  return token;
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 3600,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, COOKIE, { path: '/' });
}

export interface SessionUser {
  id: string;
  email: string;
  username: string;
}

export async function currentUser(c: Context): Promise<SessionUser | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const r = await query<SessionUser>(
    `select u.id, u.email, u.username
       from sessions s join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()`,
    [token],
  );
  return r.rows[0] ?? null;
}

export async function requireUser(c: Context, next: Next) {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', user);
  await next();
}
