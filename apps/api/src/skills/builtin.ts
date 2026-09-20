import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 内置技能：随产品发行、对所有用户可见，**不可修改/删除**。
 *
 * 存代码而非数据库：
 * - 不必给每个用户铺一份数据
 * - 我们改内容就是改代码，随发布生效
 * - 与用户自定义技能（skills 表）在列表/提示词里合并，内置始终排在最前
 *
 * 内容放在同目录 `builtin/<key>.md`（保留 frontmatter，可单独编辑）；
 * 第三方来源的技能另存 `.LICENSE.txt` 一并保留授权信息。
 */

export interface BuiltinSkill {
  /** 稳定标识；对外 id 形如 `builtin:frontend-design` */
  key: string;
  name: string;
  description: string;
  body: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** 解析 SKILL.md：`---` frontmatter 里的 name/description + 其后的正文 */
function parseSkillFile(raw: string): {
  name: string;
  description: string;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const front = m?.[1] ?? '';
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  const pick = (k: string) => {
    const line = front.split(/\r?\n/).find((l) => l.startsWith(`${k}:`));
    return line ? line.slice(k.length + 1).trim() : '';
  };
  return { name: pick('name'), description: pick('description'), body };
}

function load(key: string): BuiltinSkill {
  const raw = readFileSync(join(here, 'builtin', `${key}.md`), 'utf8');
  const { name, description, body } = parseSkillFile(raw);
  if (!name || !description || !body) {
    throw new Error(
      `[skills] 内置技能 ${key} 解析失败（name/description/body 不能为空）`,
    );
  }
  return { key, name, description, body };
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [load('frontend-design')];

/** 对外的稳定 id */
export function builtinId(key: string): string {
  return `builtin:${key}`;
}

/** 判断是否为内置技能的 id */
export function isBuiltinId(id: string): boolean {
  return id.startsWith('builtin:');
}

/** 按名字查内置技能（不区分大小写） */
export function builtinByName(name: string): BuiltinSkill | null {
  const key = name.trim().toLowerCase();
  return BUILTIN_SKILLS.find((s) => s.name.toLowerCase() === key) ?? null;
}

/** 内置技能占用的名字（用户自定义技能不允许重名） */
export function builtinNames(): string[] {
  return BUILTIN_SKILLS.map((s) => s.name);
}
