import type { FileMap, Workspace } from '@atoms/shared';

import { pool, query } from '../db';
import { getRuntime } from './index';

interface Entry {
  ws: Workspace;
  lastUsed: number;
}

// 进程内工作区缓存：同一项目跨消息复用同一沙箱（保留 node_modules，避免每次重装）
const cache = new Map<string, Entry>();

export async function loadProjectFiles(projectId: string): Promise<FileMap> {
  const r = await query<{ path: string; content: string }>(
    'select path, content from files where project_id = $1',
    [projectId],
  );
  const map: FileMap = {};
  for (const row of r.rows) map[row.path] = row.content;
  return map;
}

export async function acquireWorkspace(projectId: string): Promise<Workspace> {
  const hit = cache.get(projectId);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.ws;
  }
  const rt = getRuntime();
  const ws = await rt.open(projectId, await loadProjectFiles(projectId));
  cache.set(projectId, { ws, lastUsed: Date.now() });
  return ws;
}

/** 把沙箱内的源码快照回 A 的 DB（唯一事实源） */
export async function snapshotProject(projectId: string): Promise<FileMap> {
  const rt = getRuntime();
  const hit = cache.get(projectId);
  const ws = hit?.ws ?? (await rt.open(projectId, await loadProjectFiles(projectId)));
  const files = await rt.snapshot(ws);
  await saveProjectFiles(projectId, files);
  return files;
}

export async function saveProjectFiles(projectId: string, files: FileMap) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from files where project_id = $1', [projectId]);
    for (const [path, content] of Object.entries(files)) {
      await client.query(
        'insert into files (project_id, path, content) values ($1, $2, $3)',
        [projectId, path, content],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function destroyWorkspace(projectId: string) {
  const rt = getRuntime();
  const hit = cache.get(projectId);
  if (hit) {
    await rt.close(hit.ws).catch(() => {});
    cache.delete(projectId);
  }
}
