/**
 * 精确替换：把 current 中第一处 oldStr 替换为 newStr。
 * oldStr 必须存在，否则抛错（由调用方补充上下文）。
 */
export function applyEdit(current: string, oldStr: string, newStr: string): string {
  if (oldStr.length === 0) {
    throw new Error('old_string must not be empty');
  }
  if (!current.includes(oldStr)) {
    throw new Error('old_string not found');
  }
  return current.replace(oldStr, newStr);
}
