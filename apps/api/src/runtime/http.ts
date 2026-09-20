import { createHmac, createHash } from 'node:crypto';

import { config } from '../config';
import { logErr } from '../redact';

/**
 * A→B 调用的默认超时：隧道半死时避免请求一直挂到 undici 默认超时（~300s）。
 * 流式接口（exec）不设超时——长命令（pnpm install）本来就慢，见 `timeoutMs: 0`。
 */
const TIMEOUT_MS = 30_000;

/**
 * 沙箱调用错误。
 * `message` 是**已经面向用户写好**的文案；原始报文只进日志，
 * 避免把内网路径 / 上游响应体经由接口回传给用户。
 */
export class SandboxError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.status = status;
    this.code = code;
  }
}

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
  init: { method: string; body?: string; timeoutMs?: number },
): Promise<Response> {
  const ts = String(Date.now());
  const body = init.body ?? '';
  const sig = signature(config.sandbox.secret, ts, init.method, pathWithQuery, body);
  const timeoutMs = init.timeoutMs ?? TIMEOUT_MS;
  try {
    return await fetch(`${config.sandbox.url}${pathWithQuery}`, {
      method: init.method,
      headers: {
        'x-atoms-ts': ts,
        'x-atoms-sig': sig,
        'content-type': 'application/json',
      },
      body: body || undefined,
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    // 连不上 / 超时 / 隧道断：细节只落日志，对外给可重试的 503
    logErr('[sandbox] unreachable:', err);
    throw new SandboxError(503, 'sandbox_unreachable', '运行环境暂时不可用，请稍后重试');
  }
}

export async function signedJson<T>(
  pathWithQuery: string,
  init: { method: string; body?: string; timeoutMs?: number },
): Promise<T> {
  const res = await signedFetch(pathWithQuery, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logErr(
      `[sandbox] ${init.method} ${pathWithQuery} -> ${res.status}`,
      text.slice(0, 500),
    );
    // 只有沙箱手写的 JSON `{error,message}` 才透传（文案已是用户视角）；
    // 非 JSON（例如运行时默认 500 文本）一律换成通用文案。
    let code = 'sandbox_error';
    let message = '运行环境暂时不可用，请稍后重试';
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      if (parsed.error) code = parsed.error;
      if (parsed.message) message = parsed.message;
    } catch {
      /* 保留通用文案 */
    }
    throw new SandboxError(res.status < 500 ? res.status : 503, code, message);
  }
  return (await res.json()) as T;
}
