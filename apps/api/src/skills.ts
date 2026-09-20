import { query } from './db';
import { secretFindings } from './redact';

/**
 * Skills 领域模块：用户自定义技能（知识型）。
 *
 * 定位：技能是「知识」，不是「能力」——正文会作为**参考资料**进入模型上下文。
 * 边界（迭代 008）：
 * - 不引入执行通道：技能里要用命令行工具时，由 Agent 在沙箱内按需自行安装
 * - 不限制正文里出现凭据（用户自担），但保存时扫描并打标识提示
 */

/** 每个用户的自定义技能总数上限（含用户级 + 项目级） */
export const MAX_SKILLS_PER_USER = 20;
export const MAX_BODY_LEN = 20_000;
export const MAX_NAME_LEN = 60;
export const MAX_DESC_LEN = 200;

export interface SkillRow {
  id: string;
  user_id: string;
  project_id: string | null;
  name: string;
  description: string;
  body: string;
  secret_flags: string[];
  created_at: string;
  updated_at: string;
}

/** 列表 / 详情用的对外结构 */
export interface SkillDto {
  id: string;
  name: string;
  description: string;
  body: string;
  /** 存疑内容提示（空数组 = 没扫到） */
  secretFlags: string[];
  scope: 'user' | 'project';
  projectId: string | null;
  updatedAt: string;
}

export function toDto(row: SkillRow): SkillDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    secretFlags: row.secret_flags ?? [],
    scope: row.project_id ? 'project' : 'user',
    projectId: row.project_id,
    updatedAt: row.updated_at,
  };
}

/** 领域错误：路由层据此映射 HTTP 状态码 */
export class SkillError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

export interface SkillInput {
  name?: unknown;
  description?: unknown;
  body?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 校验并归一化输入（新建/更新共用） */
export function normalizeInput(input: SkillInput): {
  name: string;
  description: string;
  body: string;
  secretFlags: string[];
} {
  const name = str(input.name);
  const description = str(input.description);
  const body = typeof input.body === 'string' ? input.body : '';

  if (!name) throw new SkillError('invalid_input', '技能名称不能为空');
  if (name.length > MAX_NAME_LEN) {
    throw new SkillError(
      'invalid_input',
      `名称过长（上限 ${MAX_NAME_LEN} 字，当前 ${name.length} 字）`,
    );
  }
  if (/[\n\r]/.test(name)) {
    throw new SkillError('invalid_input', '技能名称不能包含换行');
  }
  if (!description) {
    throw new SkillError(
      'invalid_input',
      '请填写「适用场景」——Agent 靠它判断什么时候该用这个技能',
    );
  }
  if (description.length > MAX_DESC_LEN) {
    throw new SkillError(
      'invalid_input',
      `适用场景过长（上限 ${MAX_DESC_LEN} 字，当前 ${description.length} 字）`,
    );
  }
  if (!body.trim()) throw new SkillError('invalid_input', '技能内容不能为空');
  if (body.length > MAX_BODY_LEN) {
    throw new SkillError(
      'invalid_input',
      `内容过长（上限 ${MAX_BODY_LEN} 字，当前 ${body.length} 字）`,
    );
  }

  return { name, description, body, secretFlags: secretFindings(`${name}\n${body}`) };
}

/** 该用户当前技能总数（用于限额） */
async function countByUser(userId: string): Promise<number> {
  const r = await query<{ n: string }>(
    'select count(*) as n from skills where user_id = $1',
    [userId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function listSkills(
  userId: string,
  projectId?: string | null,
): Promise<SkillDto[]> {
  const r = await query<SkillRow>(
    `select * from skills
      where user_id = $1 and (project_id is null or project_id = $2)
      order by project_id nulls first, lower(name)`,
    [userId, projectId ?? null],
  );
  return r.rows.map(toDto);
}

export async function createSkill(
  userId: string,
  projectId: string | null,
  input: SkillInput,
): Promise<SkillDto> {
  const n = await countByUser(userId);
  if (n >= MAX_SKILLS_PER_USER) {
    throw new SkillError(
      'skill_limit',
      `技能数量已达上限（${MAX_SKILLS_PER_USER} 个），请先删除一些`,
      409,
    );
  }
  const v = normalizeInput(input);
  try {
    const r = await query<SkillRow>(
      `insert into skills (user_id, project_id, name, description, body, secret_flags)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [userId, projectId, v.name, v.description, v.body, v.secretFlags],
    );
    return toDto(r.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new SkillError('exists', '同层级已有同名技能', 409);
    }
    throw err;
  }
}

export async function updateSkill(
  userId: string,
  id: string,
  input: SkillInput,
): Promise<SkillDto> {
  const v = normalizeInput(input);
  try {
    const r = await query<SkillRow>(
      `update skills
          set name = $3, description = $4, body = $5,
              secret_flags = $6, updated_at = now()
        where id = $1 and user_id = $2
        returning *`,
      [id, userId, v.name, v.description, v.body, v.secretFlags],
    );
    if (!r.rowCount) throw new SkillError('not_found', '技能不存在', 404);
    return toDto(r.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new SkillError('exists', '同层级已有同名技能', 409);
    }
    throw err;
  }
}

export async function deleteSkill(userId: string, id: string): Promise<void> {
  const r = await query('delete from skills where id = $1 and user_id = $2', [
    id,
    userId,
  ]);
  if (!r.rowCount) throw new SkillError('not_found', '技能不存在', 404);
}

/**
 * 按名字解析本轮要用的技能（校验归属），返回可用于注入的正文。
 * 同名时项目级覆盖用户级。
 */
export async function resolveSkills(
  userId: string,
  projectId: string,
  names: string[],
): Promise<SkillRow[]> {
  if (!names.length) return [];
  const r = await query<SkillRow>(
    `select * from skills
      where user_id = $1 and (project_id is null or project_id = $2)`,
    [userId, projectId],
  );
  const byName = new Map<string, SkillRow>();
  for (const row of r.rows) {
    const key = row.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || (row.project_id && !prev.project_id)) byName.set(key, row);
  }
  const out: SkillRow[] = [];
  for (const n of names) {
    const hit = byName.get(n.trim().toLowerCase());
    if (hit) out.push(hit);
  }
  return out;
}

/** 供 list_skills 工具用：只要元信息（名字 + 适用场景），不塞正文 */
export async function skillsBrief(
  userId: string,
  projectId: string,
): Promise<{ name: string; description: string; scope: 'user' | 'project' }[]> {
  const list = await listSkills(userId, projectId);
  return list.map((s) => ({ name: s.name, description: s.description, scope: s.scope }));
}

/** 供 read_skill 工具用：取单个技能正文 */
export async function skillBody(
  userId: string,
  projectId: string,
  name: string,
): Promise<{ name: string; body: string } | null> {
  const rows = await resolveSkills(userId, projectId, [name]);
  const hit = rows[0];
  return hit ? { name: hit.name, body: hit.body } : null;
}
