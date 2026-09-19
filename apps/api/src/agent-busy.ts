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
