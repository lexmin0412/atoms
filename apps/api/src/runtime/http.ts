import { createHmac, createHash } from 'node:crypto';

import { config } from '../config';

/** 与 B 机沙箱服务约定的签名：HMAC(secret, `${ts}\n${method}\n${pathWithQuery}\n${sha256(body)}`) */
export function signature(
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

export async function signedFetch(
  pathWithQuery: string,
  init: { method: string; body?: string },
): Promise<Response> {
  const ts = String(Date.now());
  const body = init.body ?? '';
  const sig = signature(config.sandbox.secret, ts, init.method, pathWithQuery, body);
  return fetch(`${config.sandbox.url}${pathWithQuery}`, {
    method: init.method,
    headers: {
      'x-atoms-ts': ts,
      'x-atoms-sig': sig,
      'content-type': 'application/json',
    },
    body: body || undefined,
  });
}

export async function signedJson<T>(
  pathWithQuery: string,
  init: { method: string; body?: string },
): Promise<T> {
  const res = await signedFetch(pathWithQuery, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sandbox ${init.method} ${pathWithQuery} -> ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}
