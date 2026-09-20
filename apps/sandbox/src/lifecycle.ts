import { config } from './config';
import { stopDevApp } from './release';
import { listRunningSandboxIds, stopSandbox } from './workspace';

/** 回收他人沙箱的最小空闲时长：低于它就当作「正被别处使用」，不动 */
const EVICT_MIN_IDLE_MS = 60_000;

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

/**
 * 并发闸门：池满时**先尝试回收最空闲的沙箱**，而不是直接把用户挡在外面。
 *
 * 为什么：容器只是为了执行而存在，工作区文件在磁盘上不会丢（A 侧下次打开会重新同步），
 * 所以「回收一个空闲项目」比「让用户发不出消息」划算得多。
 * 正在被使用的沙箱会因为持续 touch 而保持「新鲜」，不会被选中。
 */
export async function ensureCapacity(
  id: string,
): Promise<{ ok: true; evicted?: string } | { ok: false; running: number; max: number }> {
  const running = await listRunningSandboxIds();
  if (running.length < config.maxSandboxes || running.includes(id)) return { ok: true };

  const now = Date.now();
  let victim: string | null = null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const other of running) {
    if (other === id) continue;
    const t = lastUsed.get(other);
    // 未记录的（服务重启后由 startReaper 补过）按「很久没用」处理
    const idle = now - (t ?? 0);
    if (idle >= EVICT_MIN_IDLE_MS && idle > oldest) continue;
    if (idle >= EVICT_MIN_IDLE_MS && idle < oldest) {
      oldest = idle;
      victim = other;
    }
  }
  if (victim) {
    await stopDevApp(victim).catch(() => {});
    await stopSandbox(victim).catch(() => {});
    lastUsed.delete(victim);
    console.log(`[sandbox] 并发已满，回收空闲沙箱 ${victim}（工作区文件保留）`);
    return { ok: true, evicted: victim };
  }
  return { ok: false, running: running.length, max: config.maxSandboxes };
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
