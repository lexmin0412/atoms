import { config } from './config';
import { stopDevApp } from './release';
import { listRunningSandboxIds, stopSandbox } from './workspace';

// id -> 最后使用时间
const lastUsed = new Map<string, number>();

export function touch(id: string) {
  lastUsed.set(id, Date.now());
}

export function forget(id: string) {
  lastUsed.delete(id);
}

async function reap() {
  const now = Date.now();
  for (const [id, t] of lastUsed) {
    if (now - t > config.idleTtlMs) {
      await stopDevApp(id).catch(() => {});
      await stopSandbox(id).catch(() => {});
      lastUsed.delete(id);
      console.log(`[reaper] stopped idle sandbox ${id}`);
    }
  }
}

/** 启动回收器，并接管已有的容器（避免服务重启后泄漏） */
export async function startReaper() {
  const existing = await listRunningSandboxIds();
  for (const id of existing) touch(id);
  console.log(`[sandbox] seeded ${existing.length} existing sandbox(es)`);
  setInterval(() => {
    reap().catch((err) => console.error('[reaper] error:', err));
  }, 60_000).unref();
}
