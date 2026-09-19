import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { config, SKIP_DIRS } from './config';
import { docker, wsDir } from './workspace';

/**
 * 已发布应用：每个应用一个【常驻】后端容器（与开发沙箱分离，不受空闲回收影响）。
 * 约定：生成项目的 apps/api 提供 `start` 脚本，读 PORT，监听 0.0.0.0。
 */

function containerName(id: string) {
  return `atoms-release-${id}`;
}

function uid() {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

async function exists(id: string) {
  try {
    await docker(['inspect', containerName(id)]);
    return true;
  } catch {
    return false;
  }
}

export async function releaseStatus(
  id: string,
): Promise<{ running: boolean; ip: string }> {
  try {
    const running =
      (
        await docker(['inspect', '-f', '{{.State.Running}}', containerName(id)])
      ).trim() === 'true';
    if (!running) return { running: false, ip: '' };
    const ip = (
      await docker([
        'inspect',
        '-f',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        containerName(id),
      ])
    ).trim();
    return { running: true, ip };
  } catch {
    return { running: false, ip: '' };
  }
}

export async function listReleaseIds(): Promise<string[]> {
  try {
    const out = await docker([
      'ps',
      '--filter',
      'name=atoms-release-',
      '--format',
      '{{.Names}}',
    ]);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => n.replace(/^atoms-release-/, ''));
  } catch {
    return [];
  }
}

/** 发布副本目录（源码冻结，与开发工作区隔离） */
function releaseDir(id: string) {
  return join(config.root + '-releases', id);
}

/** 把开发工作区源码冻结成独立副本（排除 node_modules/dist/.git 等） */
export async function freezeReleaseSource(id: string): Promise<string> {
  const src = wsDir(id);
  const dst = releaseDir(id);
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });
  // 用 tar 流式复制并排除大目录，避免 cp 把 node_modules 也带过去
  const excludes = [...SKIP_DIRS].flatMap((d) => ['--exclude', `./${d}`]);
  await docker([
    'run',
    '--rm',
    '-v',
    `${src}:/src:ro`,
    '-v',
    `${dst}:/dst`,
    config.image,
    'sh',
    '-lc',
    `cd /src && tar ${excludes.join(' ')} -cf - . | (cd /dst && tar -xf -)`,
  ]);
  return dst;
}

/** 启动（或重启）应用的常驻后端容器；运行【冻结副本】，与开发工作区隔离 */
export async function startRelease(
  id: string,
  databaseUrl: string,
): Promise<{ running: boolean; ip: string }> {
  if (await exists(id)) {
    await docker(['rm', '-f', containerName(id)]).catch(() => {});
  }

  const src = await freezeReleaseSource(id);
  const store = join(config.root, '.pnpm-store');
  await docker([
    'run',
    '-d',
    '--name',
    containerName(id),
    `--memory=${config.memory}`,
    `--memory-swap=${config.memory}`,
    '--cpus=1',
    '--pids-limit=256',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user',
    uid(),
    '--network',
    config.network,
    '-v',
    `${src}:/workspace`,
    '-v',
    `${store}:/pnpm-store`,
    '-e',
    `PORT=${config.releasePort}`,
    '-e',
    'HOST=0.0.0.0',
    '-e',
    `DATABASE_URL=${databaseUrl}`,
    '-w',
    '/workspace',
    config.image,
    'sh',
    '-lc',
    'pnpm install --prefer-offline && pnpm --filter ./apps/api start',
  ]);

  // 容器内先 install 再 start，首次需要一点时间
  return { running: true, ip: '' };
}

export async function stopRelease(id: string) {
  await docker(['rm', '-f', containerName(id)]).catch(() => {});
  // 清理冻结副本（下架后不再需要）
  await rm(releaseDir(id), { recursive: true, force: true }).catch(() => {});
}

/** 就绪探测：容器在跑、拿到了 IP、且容器内后端已能接受连接 */
export async function releaseReady(
  id: string,
): Promise<{ running: boolean; ip: string; ready: boolean }> {
  const st = await releaseStatus(id);
  if (!st.running || !st.ip) return { ...st, ready: false };
  try {
    await fetch(`http://${st.ip}:${config.releasePort}/`, { method: 'GET' });
    return { ...st, ready: true };
  } catch {
    return { ...st, ready: false };
  }
}

// ---- 开发预览用的应用后端 ----
// 跑在【独立容器】里（挂载同一开发工作区），便于「重新构建」时干净重启。

function devAppContainerName(id: string) {
  return `atoms-devapp-${id}`;
}

async function containerIp(name: string): Promise<string> {
  try {
    return (
      await docker([
        'inspect',
        '-f',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        name,
      ])
    ).trim();
  } catch {
    return '';
  }
}

/** 启动（或强制重启）开发预览后端容器；运行【开发工作区】的最新源码 */
export async function startDevApp(
  id: string,
  databaseUrl: string,
  force = false,
): Promise<void> {
  const name = devAppContainerName(id);
  if (force) {
    await docker(['rm', '-f', name]).catch(() => {});
  } else if (await containerIp(name)) {
    return; // 已在跑
  }

  const store = join(config.root, '.pnpm-store');
  await docker([
    'run',
    '-d',
    '--name',
    name,
    `--memory=${config.memory}`,
    `--memory-swap=${config.memory}`,
    '--cpus=1',
    '--pids-limit=256',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user',
    uid(),
    '--network',
    config.network,
    '-v',
    `${wsDir(id)}:/workspace`,
    '-v',
    `${store}:/pnpm-store`,
    '-e',
    `PORT=${config.devAppPort}`,
    '-e',
    'HOST=0.0.0.0',
    '-e',
    `DATABASE_URL=${databaseUrl}`,
    '-w',
    '/workspace',
    config.image,
    'sh',
    '-lc',
    'pnpm install --prefer-offline && pnpm --filter ./apps/api start',
  ]);
}

export async function stopDevApp(id: string): Promise<void> {
  await docker(['rm', '-f', devAppContainerName(id)]).catch(() => {});
}

/** 开发应用后端是否就绪 */
export async function devAppReady(
  id: string,
): Promise<{ running: boolean; ip: string; ready: boolean }> {
  const ip = await containerIp(devAppContainerName(id));
  if (!ip) return { running: false, ip: '', ready: false };
  try {
    const res = await fetch(`http://${ip}:${config.devAppPort}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return { running: true, ip, ready: res.ok };
  } catch {
    return { running: true, ip, ready: false };
  }
}

/** 开发应用后端地址（供反代） */
export async function devAppTarget(id: string): Promise<string> {
  const ip = await containerIp(devAppContainerName(id));
  return ip ? `http://${ip}:${config.devAppPort}` : '';
}
