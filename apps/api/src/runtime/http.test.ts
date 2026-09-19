import { createHash, createHmac } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import { signature } from './http';

// 与 B 机沙箱服务约定的签名公式：
// HMAC-SHA256(secret, `${ts}\n${method}\n${pathWithQuery}\n${sha256hex(body)}`)
// 本用例锁死该格式，防止任一端改动导致鉴权悄悄失效。
describe('signature', () => {
  it('与约定的公式一致（固定向量）', () => {
    const secret = 's3cr3t';
    const ts = '1700000000000';
    const method = 'POST';
    const path = '/sandbox/abc/exec';
    const body = '{"cmd":"ls"}';
    const expected = createHmac('sha256', secret)
      .update(
        `${ts}\n${method}\n${path}\n${createHash('sha256').update(body).digest('hex')}`,
      )
      .digest('hex');
    expect(signature(secret, ts, method, path, body)).toBe(expected);
  });

  it('body / method / path 任一变化都会改变签名', () => {
    const base = signature('s', '1', 'POST', '/p', '{"a":1}');
    expect(signature('s', '1', 'POST', '/p', '{"a":2}')).not.toBe(base);
    expect(signature('s', '1', 'GET', '/p', '{"a":1}')).not.toBe(base);
    expect(signature('s', '1', 'POST', '/q', '{"a":1}')).not.toBe(base);
  });
});
