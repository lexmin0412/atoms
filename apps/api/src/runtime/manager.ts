import type { FileMap, Workspace } from '@atoms/shared';

import { loadFileMap, saveFileMap } from '../filetree';
import { logErr } from '../redact';
import { ensureDevSchema, databaseUrlFor } from '../release/db';
import { getRuntime } from './index';

interface Entry {
  ws: Workspace;
  lastUsed: number;
}

// 进程内工作区缓存：同一项目跨消息复用同一沙箱（保留 node_modules，避免每次重装）
const cache = new Map<string, Entry>();

export async function loadProjectFiles(projectId: string): Promise<FileMap> {
  return loadFileMap(projectId);
}

/** 开发沙箱连的是 dev_<短id>，与生产的 app_<短id> 隔离 */
async function devDatabaseUrl(projectId: string): Promise<string> {
  const schema = await ensureDevSchema(projectId);
  return await databaseUrlFor(schema);
}

export async function acquireWorkspace(projectId: string): Promise<Workspace> {
  const hit = cache.get(projectId);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.ws;
  }
  const rt = getRuntime();
  const ws = await rt.open(
    projectId,
    await loadProjectFiles(projectId),
    await devDatabaseUrl(projectId),
  );
  cache.set(projectId, { ws, lastUsed: Date.now() });
  return ws;
}

/** 把沙箱内的源码快照回 A 的 DB（唯一事实源） */
export async function snapshotProject(projectId: string): Promise<FileMap> {
  const rt = getRuntime();
  const hit = cache.get(projectId);
  const ws =
    hit?.ws ??
    (await rt.open(
      projectId,
      await loadProjectFiles(projectId),
      await devDatabaseUrl(projectId),
    ));
  const files = await rt.snapshot(ws);
  await saveProjectFiles(projectId, files);
  return files;
}

export async function saveProjectFiles(projectId: string, files: FileMap) {
  await saveFileMap(projectId, files);
}

export async function destroyWorkspace(projectId: string) {
  const rt = getRuntime();
  const hit = cache.get(projectId);
  if (hit) {
    await rt.close(hit.ws).catch(() => {});
    cache.delete(projectId);
  }
}

/**
 * 在开发沙箱上执行一次增量同步（写/删文件）。
 * DB 是唯一事实源：同步失败不应让写请求失败 —— 丢弃工作区缓存，
 * 下次 acquireWorkspace 会从 DB 全量重建，从而自愈。
 */
export async function withWorkspace(
  projectId: string,
  fn: (rt: ReturnType<typeof getRuntime>, ws: Workspace) => Promise<void>,
) {
  const rt = getRuntime();
  try {
    const ws = await acquireWorkspace(projectId);
    await fn(rt, ws);
  } catch (err) {
    logErr('[workspace] sync failed, will resync from DB:', err);
    cache.delete(projectId);
    try {
      const ws = await acquireWorkspace(projectId);
      await fn(rt, ws);
    } catch (retryErr) {
      logErr('[workspace] resync failed (DB 仍为事实源):', retryErr);
      cache.delete(projectId);
    }
  }
}
