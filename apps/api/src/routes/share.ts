import { Hono, type Context } from 'hono';
import { query } from '../db';

export const shareRoutes = new Hono();

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

function mimeOf(p: string) {
  const i = p.lastIndexOf('.');
  return i >= 0 ? (MIME[p.slice(i).toLowerCase()] ?? 'application/octet-stream') : 'text/html; charset=utf-8';
}

async function getFile(token: string, path: string) {
  const r = await query<{ content_b64: string }>(
    'select content_b64 from share_files where token = $1 and path = $2',
    [token, path],
  );
  return r.rows[0]?.content_b64 ?? null;
}

/** 公开只读分享（无需登录） */
async function serveShare(c: Context) {
  const token = c.req.param('token');
  if (!token) return c.text('Not found', 404);
  const url = new URL(c.req.url);
  const prefix = `/share/${token}/`;
  let rel = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  if (!rel) rel = 'index.html';

  let content = await getFile(token, rel);
  if (content === null) {
    rel = 'index.html';
    content = await getFile(token, rel);
  }
  if (content === null) return c.text('Not found', 404);

  const buf = Buffer.from(content, 'base64');
  return new Response(buf, {
    headers: { 'Content-Type': mimeOf(rel), 'Cache-Control': 'public, max-age=60' },
  });
}

shareRoutes.get('/:token', serveShare);
shareRoutes.get('/:token/*', serveShare);
