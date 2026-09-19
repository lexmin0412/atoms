import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import COS from 'cos-nodejs-sdk-v5';

import { config } from '../config';

/**
 * 前端产物托管。
 * - 配置了 COS（COS_BUCKET + 密钥）→ 上传到 COS，由前门 nginx 回源
 * - 否则 → 写本地目录（由前门 nginx 直接托管）
 */
export const APPS_ROOT = process.env.APPS_ROOT ?? '/srv/atoms-apps';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentType(path: string) {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function publishLocal(projectId: string, files: Record<string, string>) {
  const base = join(APPS_ROOT, projectId);
  await rm(base, { recursive: true, force: true });
  for (const [path, b64] of Object.entries(files)) {
    const full = join(base, path);
    if (!full.startsWith(base)) continue; // 防路径穿越
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, Buffer.from(b64, 'base64'));
  }
  return base;
}

async function publishCos(projectId: string, files: Record<string, string>) {
  const cos = new COS({
    SecretId: config.cos.secretId,
    SecretKey: config.cos.secretKey,
  });
  const prefix = `apps/${projectId}/`;
  await Promise.all(
    Object.entries(files).map(
      ([path, b64]) =>
        new Promise<void>((resolve, reject) => {
          cos.putObject(
            {
              Bucket: config.cos.bucket,
              Region: config.cos.region,
              Key: prefix + path,
              Body: Buffer.from(b64, 'base64'),
              ContentType: contentType(path),
              // 显式内联，避免浏览器把页面当附件下载
              ContentDisposition: 'inline',
              ACL: 'public-read',
            },
            (err) => (err ? reject(err) : resolve()),
          );
        }),
    ),
  );
  return `cos://${config.cos.bucket}/${prefix}`;
}

export async function publishFrontend(
  projectId: string,
  files: Record<string, string>,
): Promise<string> {
  if (config.cos.bucket && config.cos.secretId) {
    return publishCos(projectId, files);
  }
  return publishLocal(projectId, files);
}
