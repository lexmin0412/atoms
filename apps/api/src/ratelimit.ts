/**
 * 进程内限流（单实例足够：A 机只有一个 atoms-api 进程）。
 * 用途：登录/注册的暴力破解与批量注册防护。
 *
 * 策略：每 key 在窗口内最多 N 次失败；超限后封锁一段时间，
 * 连续触发则封锁时长翻倍（有上限）。
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 8;
const BASE_BLOCK_MS = 15 * 60 * 1000;
const MAX_BLOCK_MS = 6 * 60 * 60 * 1000;

interface Bucket {
  fails: number;
  firstAt: number;
  blockedUntil: number;
  strikes: number;
}

const buckets = new Map<string, Bucket>();

export interface LimitState {
  ok: boolean;
  retryAfterSec?: number;
}

export function checkLimit(key: string, now = Date.now()): LimitState {
  const b = buckets.get(key);
  if (!b) return { ok: true };
  if (b.blockedUntil > now) {
    return { ok: false, retryAfterSec: Math.ceil((b.blockedUntil - now) / 1000) };
  }
  if (now - b.firstAt > WINDOW_MS) {
    buckets.delete(key);
    return { ok: true };
  }
  return { ok: true };
}

export function recordFailure(key: string, now = Date.now()): void {
  const b = buckets.get(key);
  if (!b || now - b.firstAt > WINDOW_MS) {
    buckets.set(key, { fails: 1, firstAt: now, blockedUntil: 0, strikes: 0 });
    return;
  }
  b.fails += 1;
  if (b.fails >= MAX_FAILS) {
    b.strikes += 1;
    const block = Math.min(BASE_BLOCK_MS * 2 ** (b.strikes - 1), MAX_BLOCK_MS);
    b.blockedUntil = now + block;
    b.fails = 0;
    b.firstAt = now;
  }
}

export function clearFailures(key: string): void {
  buckets.delete(key);
}

/**
 * 客户端 IP：只信任 nginx 追加的最后一个 XFF 项
 * （`proxy_add_x_forwarded_for` 会把真实来源追加到末尾，前面的可被伪造）。
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return headers.get('x-real-ip') ?? 'unknown';
}

/** 测试用：清空所有计数 */
export function resetLimits(): void {
  buckets.clear();
}
