import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { logErr } from './redact';
import { SandboxError } from './runtime/http';

/** 内部错误对外的统一文案（细节只进日志） */
export const UNAVAILABLE_MESSAGE = '服务暂时不可用，请稍后重试';

/**
 * 把异常统一转成用户可见的 JSON 响应。
 * - 沙箱错误：文案已在 SandboxError 里准备好（不含内部细节），按其语义状态码返回
 * - 其它异常：记日志 + 通用文案，**绝不**回传 err.message（曾把内网路径/上游报文泄露给用户）
 */
export function fail(c: Context, err: unknown): Response {
  if (err instanceof SandboxError) {
    return c.json(
      { error: err.code, message: err.message },
      err.status as ContentfulStatusCode,
    );
  }
  logErr('[api] unhandled error:', err);
  return c.json({ error: 'internal_error', message: UNAVAILABLE_MESSAGE }, 500);
}
