import { join } from 'node:path';

import { config } from './config';
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

/** 启动（或重启）应用的常驻后端容器；返回容器网络地址 */
export async function startRelease(
  id: string,
  databaseUrl: string,
): Promise<{ running: boolean; ip: string }> {
  const current = await releaseStatus(id);
  if (current.running) return current;

  if (await exists(id)) {
    await docker(['rm', '-f', containerName(id)]).catch(() => {});
  }

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
    `${wsDir(id)}:/workspace`,
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
