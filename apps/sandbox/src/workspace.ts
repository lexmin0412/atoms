import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** 共享卷在【容器内】的挂载点（与宿主路径是两个世界，别混用） */
export const STORE_MOUNT = '/pnpm-store';
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
  // 技能依赖的 npm CLI 装到【共享卷】：容器内 /usr/local 是 root 所有、uid 1000 写不了，
  // 指到共享卷后既能装、又能跨容器重建保留（默认 registry 已是内网镜像）。
  const containerPrefix = join(STORE_MOUNT, 'npm-global');
  const envArgs = [
    // 非交互：避免 pnpm 在无 TTY 时因「需要确认清空 node_modules」直接 abort
    // （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY，会让依赖装不上、应用起不来）
    '-e',
    'CI=true',
    '-e',
    `NPM_CONFIG_PREFIX=${containerPrefix}`,
    // 注意：dash 作为 login shell 会重置 PATH，所以镜像里另有 /etc/profile.d 兜底
    '-e',
    `PATH=${containerPrefix}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...(databaseUrl ? ['-e', `DATABASE_URL=${databaseUrl}`] : []),
  ];
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
    `${store}:${STORE_MOUNT}`,
    '-w',
    '/workspace',
    config.image,
    'sh',
    '-lc',
    // 注：设了 NPM_CONFIG_PREFIX 后，pnpm 会去 $PREFIX/etc/npmrc 找【全局配置】，
    // 那里没有就会退回内置默认（registry.npmjs.org + 默认 store）——
    // 既慢（国内拉 npmjs）又与 devapp 的 store 不一致，导致 node_modules 被判不兼容。
    // 启动时把镜像里的全局 npmrc 镜像过去，保证两边配置一致。
    `mkdir -p ${containerPrefix}/etc && cp -f /usr/local/etc/npmrc ${containerPrefix}/etc/npmrc 2>/dev/null; exec sleep infinity`,
  ]);
  invalidateRunningCache();
}

/** 只删容器（保留工作区目录，便于自愈重建） */
export async function stopSandbox(id: string) {
  await docker(['rm', '-f', containerName(id)]).catch(() => {});
  invalidateRunningCache();
}

/** 删容器 + 删工作区目录 */
export async function destroySandbox(id: string) {
  await stopSandbox(id);
  await rm(wsDir(id), { recursive: true, force: true }).catch(() => {});
}

/**
 * `docker ps` 结果缓存：并发闸门（ensureCapacity）在**写文件**这类高频路径上也会调用，
 * 每次都拉起 docker CLI 会让单次写文件从 ~10ms 变成 ~1s（实测平均 972ms、最大 13.6s，
 * 恢复一个 3381 文件的仓库要 3.5 分钟，前端等不到自动拉起就超时了）。
 * 2s 的陈旧度对并发上限判断没有实际影响。
 */
let runningCache: { at: number; ids: string[] } | null = null;
const RUNNING_CACHE_MS = 2_000;

function invalidateRunningCache() {
  runningCache = null;
}

/**
 * 当前运行中的开发沙箱 id 列表。
 * 注意：docker 的 `name=atoms-` 是子串匹配，会连带命中
 * `atoms-devapp-<id>`（开发预览后端）与 `atoms-release-<id>`（已发布应用），
 * 这两类不算开发沙箱名额，必须排除，否则并发闸门会被误占满。
 */
export async function listRunningSandboxIds(): Promise<string[]> {
  const now = Date.now();
  if (runningCache && now - runningCache.at < RUNNING_CACHE_MS) return runningCache.ids;
  try {
    const out = await docker(['ps', '--filter', 'name=atoms-', '--format', '{{.Names}}']);
    const ids = out
      .split('\n')
      .map((s) => s.trim())
      .filter(
        (n) =>
          n.startsWith('atoms-') &&
          !n.startsWith('atoms-devapp-') &&
          !n.startsWith('atoms-release-'),
      )
      .map((n) => n.replace(/^atoms-/, ''));
    runningCache = { at: now, ids };
    return ids;
  } catch {
    return [];
  }
}

export async function isSandboxRunning(id: string) {
  return isRunning(id);
}

export function execStream(
  id: string,
  cmd: string,
  onActivity?: () => void,
): ReadableStream<Uint8Array> {
  const child = spawn('docker', ['exec', containerName(id), 'sh', '-lc', cmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (obj: unknown) =>
        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      child.stdout.on('data', (d: Buffer) => {
        onActivity?.();
        push({ stream: 'stdout', data: d.toString('utf8') });
      });
      child.stderr.on('data', (d: Buffer) => {
        onActivity?.();
        push({ stream: 'stderr', data: d.toString('utf8') });
      });
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

/** 删除工作区内的文件或目录（目录递归） */
export async function removeWsPath(id: string, path: string) {
  const p = safeJoin(id, path);
  await rm(p, { recursive: true, force: true });
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

/**
 * 工作区内每个文件的内容哈希（跳过 SKIP_DIRS）。
 * A 机出口带宽很小（实测 ~150KB/s），整仓重传要几分钟；恢复工作区前先用它
 * 比对，只上传缺失/内容不同的文件——正常情况下一个字节都不用传。
 */
export async function hashWsFiles(id: string): Promise<Record<string, string>> {
  const base = wsDir(id);
  const out: Record<string, string> = {};
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
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      const buf = await readFile(full).catch(() => null);
      if (buf) out[relative(base, full)] = createHash('sha256').update(buf).digest('hex');
    }
  }
  await walk(base);
  return out;
}

/** 整仓摘要：对「路径+内容哈希」排序后取一次 sha256，A 侧用同一算法比对 */
export async function wsDigest(id: string): Promise<string> {
  const hashes = await hashWsFiles(id);
  const lines = Object.keys(hashes)
    .sort()
    .map((p) => `${p}\u0000${hashes[p]}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** 对比 A 侧清单：返回需要上传（缺失或内容不同）的文件路径 */
export async function wsSyncPlan(
  id: string,
  want: Record<string, string>,
): Promise<string[]> {
  const have = await hashWsFiles(id);
  return Object.keys(want).filter((p) => have[p] !== want[p]);
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
