import { Hono } from 'hono';
import { z } from 'zod';

import { requireUser } from '../auth';
import { query } from '../db';
import { fail } from '../respond';
import {
  createSkill,
  deleteSkill,
  listSkills,
  MAX_BODY_LEN,
  MAX_DESC_LEN,
  MAX_NAME_LEN,
  MAX_SKILLS_PER_USER,
  SkillError,
  updateSkill,
} from '../skills';
import type { Env } from './auth';

export const skillRoutes = new Hono<Env>();

skillRoutes.use('*', requireUser);

/**
 * 这里只做【类型】校验，长度/空白/包名等业务校验统一交给 `normalizeInput`。
 * 否则 zod 的 max 会先拦下、返回一句笼统的提示（曾出现「明明填了却提示请填写」的误导）。
 */
const inputSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
});

const FIELD_LABEL: Record<string, string> = {
  name: '名称',
  description: '适用场景',
  body: '内容',
};

function parseInput(
  raw: unknown,
): { ok: true; data: z.infer<typeof inputSchema> } | { ok: false; message: string } {
  const parsed = inputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const field = String(parsed.error.issues[0]?.path?.[0] ?? '');
  const label = FIELD_LABEL[field] ?? '输入';
  return { ok: false, message: `${label}格式不正确（需要文本）` };
}

function skillFail(c: Parameters<typeof fail>[0], err: unknown): Response {
  if (err instanceof SkillError) {
    return c.json({ error: err.code, message: err.message }, err.status as never);
  }
  return fail(c, err);
}

/** 校验 projectId 归属（可选） */
async function ownProject(userId: string, projectId: string): Promise<boolean> {
  const r = await query('select 1 from projects where id = $1 and user_id = $2', [
    projectId,
    userId,
  ]);
  return Boolean(r.rowCount);
}

/** 列表：用户级 + 指定项目级 */
skillRoutes.get('/', async (c) => {
  const user = c.get('user');
  const projectId = c.req.query('projectId') || null;
  if (projectId && !(await ownProject(user.id, projectId))) {
    return c.json({ error: 'not_found', message: '项目不存在或无权访问' }, 404);
  }
  try {
    const skills = await listSkills(user.id, projectId);
    return c.json({
      skills,
      limit: MAX_SKILLS_PER_USER,
      limits: { name: MAX_NAME_LEN, description: MAX_DESC_LEN, body: MAX_BODY_LEN },
    });
  } catch (err) {
    return skillFail(c, err);
  }
});

/** 新建：projectId 为空 = 用户级 */
skillRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req
    .json<{ projectId?: string | null }>()
    .catch(() => ({}) as { projectId?: string | null });
  const projectId = body.projectId ?? null;
  const parsed = parseInput(body);
  if (!parsed.ok) {
    return c.json({ error: 'invalid_input', message: parsed.message }, 400);
  }
  if (projectId && !(await ownProject(user.id, projectId))) {
    return c.json({ error: 'not_found', message: '项目不存在或无权访问' }, 404);
  }
  try {
    const skill = await createSkill(user.id, projectId, parsed.data);
    return c.json({ skill });
  } catch (err) {
    return skillFail(c, err);
  }
});

skillRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const parsed = parseInput(await c.req.json().catch(() => ({})));
  if (!parsed.ok) {
    return c.json({ error: 'invalid_input', message: parsed.message }, 400);
  }
  try {
    const skill = await updateSkill(user.id, c.req.param('id'), parsed.data);
    return c.json({ skill });
  } catch (err) {
    return skillFail(c, err);
  }
});

skillRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  try {
    await deleteSkill(user.id, c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    return skillFail(c, err);
  }
});
