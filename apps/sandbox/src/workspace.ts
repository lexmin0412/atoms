import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, relative, dirname, extname } from 'node:path';
import { promisify } from 'node:util';

import { config, SKIP_DIRS } from './config';

const execFileAsync = promisify(execFile);

export async function docker(args: string[]) {
  const { stdout } = await execFileAsync('docker', args, {
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

export function wsDir(id: string) {
  return join(config.root, id);
}
function containerName(id: string) {
  return `atoms-${id}`;
}

async function containerExists(id: string) {
  try {
    await docker(['inspect', containerName(id)]);
    return true;
  } catch {
    return false;
  }
}

async function isRunning(id: string) {
  try {
    const s = await docker(['inspect', '-f', '{{.State.Running}}', containerName(id)]);
    return s.trim() === 'true';
  } catch {
    return false;
  }
}

export async function ensureSandbox(id: string, databaseUrl?: string) {
  await mkdir(wsDir(id), { recursive: true });
  const store = join(config.root, '.pnpm-store');
  await mkdir(store, { recursive: true });
  if (await isRunning(id)) return;
  if (await containerExists(id)) {
    await docker(['rm', '-f', containerName(id)]).catch(() => {});
  }
  const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const envArgs = databaseUrl ? ['-e', `DATABASE_URL=${databaseUrl}`] : [];
  await docker([
    'run',
    '-d',
    '--name',
    containerName(id),
    `--memory=${config.memory}`,
    `--memory-swap=${config.memory}`,
    `--cpus=${config.cpus}`,
    '--pids-limit=256',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user',
    uid,
    '--network',
    config.network,
    ...envArgs,
    '-v',
    `${wsDir(id)}:/workspace`,
    '-v',
    `${store}:/pnpm-store`,
    '-w',
    '/workspace',
    config.image,
    'sleep',
    'infinity',
  ]);
}

/** 只删容器（保留工作区目录，便于自愈重建） */
export async function stopSandbox(id: string) {
  await docker(['rm', '-f', containerName(id)]).catch(() => {});
}

/** 删容器 + 删工作区目录 */
export async function destroySandbox(id: string) {
  await stopSandbox(id);
  await rm(wsDir(id), { recursive: true, force: true }).catch(() => {});
}

/** 当前运行中的沙箱 id 列表 */
export async function listRunningSandboxIds(): Promise<string[]> {
  try {
    const out = await docker(['ps', '--filter', 'name=atoms-', '--format', '{{.Names}}']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => n.replace(/^atoms-/, ''));
  } catch {
    return [];
  }
}

export async function isSandboxRunning(id: string) {
  return isRunning(id);
}

export function execStream(id: string, cmd: string): ReadableStream<Uint8Array> {
  const child = spawn('docker', ['exec', containerName(id), 'sh', '-lc', cmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (obj: unknown) =>
        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      child.stdout.on('data', (d: Buffer) =>
        push({ stream: 'stdout', data: d.toString('utf8') }),
      );
      child.stderr.on('data', (d: Buffer) =>
        push({ stream: 'stderr', data: d.toString('utf8') }),
      );
      child.on('error', (err) => {
        push({ stream: 'stderr', data: String(err) });
        push({ exitCode: 1 });
        controller.close();
      });
      child.on('close', (code) => {
        push({ exitCode: code ?? 0 });
        controller.close();
      });
    },
    cancel() {
      child.kill('SIGKILL');
    },
  });
}

function safeJoin(id: string, rel: string) {
  const base = wsDir(id);
  const p = resolve(base, rel.replace(/^\/+/, ''));
  if (p !== base && !p.startsWith(base + '/')) {
    throw new Error('path escapes workspace');
  }
  return p;
}

export async function readWsFile(id: string, path: string) {
  return readFile(safeJoin(id, path), 'utf8');
}

export async function writeWsFile(id: string, path: string, content: string) {
  const p = safeJoin(id, path);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, 'utf8');
}

export async function listWsFiles(id: string): Promise<string[]> {
  const base = wsDir(id);
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(relative(base, full));
    }
  }
  await walk(base);
  return out.sort();
}

export async function snapshotWorkspace(id: string) {
  const files = await listWsFiles(id);
  const map: Record<string, string> = {};
  for (const f of files) {
    map[f] = await readFile(safeJoin(id, f), 'utf8').catch(() => '');
  }
  return map;
}

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

/** 读取前端构建产物 apps/web/dist 下的文件（用于预览） */
export async function readDistFile(id: string, rel: string) {
  const base = join(wsDir(id), 'apps/web/dist');
  let p = resolve(base, (rel || 'index.html').replace(/^\/+/, ''));
  if (p !== base && !p.startsWith(base + '/')) throw new Error('path escapes dist');
  try {
    const s = await stat(p);
    if (s.isDirectory()) p = join(p, 'index.html');
  } catch {
    // 不存在则尝试 index.html（SPA 回退）
    p = join(base, 'index.html');
  }
  const buffer = await readFile(p);
  return {
    buffer,
    contentType: MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
  };
}

/** 构建产物版本（用 dist/index.html 的 mtime），用于前端轮询刷新预览 */
export async function distVersion(id: string): Promise<string> {
  try {
    const s = await stat(join(wsDir(id), 'apps/web/dist/index.html'));
    return String(Math.floor(s.mtimeMs));
  } catch {
    return '';
  }
}

/** 快照整个 dist 目录（base64），用于发布 */
export async function snapshotDist(id: string): Promise<Record<string, string>> {
  const base = join(wsDir(id), 'apps/web/dist');
  const map: Record<string, string> = {};
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const buf = await readFile(full);
        map[relative(base, full)] = buf.toString('base64');
      }
    }
  }
  await walk(base);
  return map;
}
