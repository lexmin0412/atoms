/**
 * 进程内在途生成标记：同一项目同一时刻只应有一个 Agent 循环。
 * 用于「生成中禁止手动编辑文件」。
 */
const busy = new Set<string>();

export function markBusy(projectId: string) {
  busy.add(projectId);
}

export function clearBusy(projectId: string) {
  busy.delete(projectId);
}

export function isBusy(projectId: string): boolean {
  return busy.has(projectId);
}

/**
 * 在途轮次注册表。同一个项目**不能**同时有两个轮次在跑：
 * 两个请求会用同一个 `x-opencode-session` 打上游，上游会把先到的那条流掐断
 * （表现为 `Client connection prematurely closed`、回复半截落库）——线上真实事故。
 * 所以新请求进来先把上一轮优雅收尾（已生成内容照常落库），再开始新一轮。
 */
type Round = { controller: AbortController; done: Promise<void> };
const rounds = new Map<string, Round>();

export function registerRound(
  projectId: string,
  controller: AbortController,
  done: Promise<void>,
) {
  rounds.set(projectId, { controller, done });
}

export function unregisterRound(projectId: string) {
  rounds.delete(projectId);
}

/** 让上一个同项目轮次收尾；返回是否确实打断了一个在途轮次 */
export async function supersedeRound(
  projectId: string,
  waitMs = 10_000,
): Promise<boolean> {
  const prev = rounds.get(projectId);
  if (!prev) return false;
  prev.controller.abort(new Error('superseded'));
  await Promise.race([
    prev.done.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, waitMs)),
  ]);
  return true;
}
