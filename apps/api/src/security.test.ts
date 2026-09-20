import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { originGuard } from './origin';
import {
  checkLimit,
  clearFailures,
  clientIp,
  recordFailure,
  resetLimits,
} from './ratelimit';

describe('clientIp', () => {
  it('取 XFF 的最后一项（前面的可被伪造）', () => {
    const h = new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' });
    expect(clientIp(h)).toBe('203.0.113.9');
  });

  it('回退到 x-real-ip', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '10.0.0.2' }))).toBe('10.0.0.2');
  });
});

describe('限流', () => {
  beforeEach(() => resetLimits());

  it('连续失败达到阈值后封锁', () => {
    const key = 'login:acct:a@b.c';
    for (let i = 0; i < 8; i += 1) {
      expect(checkLimit(key).ok).toBe(true);
      recordFailure(key);
    }
    const st = checkLimit(key);
    expect(st.ok).toBe(false);
    expect(st.retryAfterSec).toBeGreaterThan(0);
  });

  it('成功后清除计数', () => {
    const key = 'login:ip:1.1.1.1';
    recordFailure(key);
    recordFailure(key);
    clearFailures(key);
    expect(checkLimit(key).ok).toBe(true);
  });

  it('窗口过期后自动放行', () => {
    const key = 'login:ip:2.2.2.2';
    const t0 = Date.now();
    for (let i = 0; i < 8; i += 1) recordFailure(key, t0);
    expect(checkLimit(key, t0).ok).toBe(false);
    // 11 分钟后窗口滚出（封锁 15 分钟，故此处仍在封锁期）
    expect(checkLimit(key, t0 + 16 * 60 * 1000).ok).toBe(true);
  });
});

describe('originGuard', () => {
  const app = new Hono();
  app.use('*', originGuard);
  app.post('/x', (c) => c.json({ ok: true }));
  app.get('/x', (c) => c.json({ ok: true }));

  it('放行本站 Origin', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
  });

  it('拒绝其它 Origin', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });

  it('拒绝 cross-site 的 Sec-Fetch-Site', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('放行不带 Origin 的请求（CLI / 服务端）', async () => {
    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('GET 不校验', async () => {
    const res = await app.request('/x', {
      method: 'GET',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(200);
  });
});
