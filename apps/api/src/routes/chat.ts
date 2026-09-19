import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { Hono } from 'hono';

import { model, SYSTEM_PROMPT } from '../agent';
import { requireUser } from '../auth';
import { config } from '../config';
import { query } from '../db';
import { getRuntime } from '../runtime';
import { acquireWorkspace, snapshotProject } from '../runtime/manager';
import { createTools } from '../tools';
import type { Env } from './auth';

export const chatRoutes = new Hono<Env>();

chatRoutes.use('*', requireUser);

async function saveMessage(
  projectId: string,
  role: 'user' | 'assistant',
  parts: unknown,
) {
  const r = await query<{ next: number }>(
    'select coalesce(max(seq), 0) + 1 as next from messages where project_id = $1',
    [projectId],
  );
  await query(
    'insert into messages (project_id, seq, role, parts) values ($1, $2, $3, $4)',
    [projectId, r.rows[0].next, role, JSON.stringify(parts)],
  );
}

chatRoutes.post('/:id/chat', async (c) => {
  const user = c.get('user');
  const projectId = c.req.param('id');

  const own = await query('select 1 from projects where id = $1 and user_id = $2', [
    projectId,
    user.id,
  ]);
  if (!own.rowCount) return c.json({ error: 'not_found' }, 404);

  // 额度：限制每用户 24h 内的消息数（防滥用；上游配额仅作兜底）
  const usage = await query<{ n: number }>(
    `select count(*)::int as n
       from messages m join projects p on p.id = m.project_id
      where p.user_id = $1 and m.role = 'user'
        and m.created_at > now() - interval '24 hours'`,
    [user.id],
  );
  if ((usage.rows[0]?.n ?? 0) >= config.dailyMessageLimit) {
    return c.json(
      {
        error: 'quota_exceeded',
        message: `已达到 24 小时内的消息上限（${config.dailyMessageLimit} 条），请稍后再试`,
      },
      429,
    );
  }

  const body = await c.req.json<{ messages?: UIMessage[] }>().catch(() => null);
  const uiMessages = body?.messages ?? [];
  const lastUser = [...uiMessages].reverse().find((m) => m.role === 'user');
  if (lastUser) await saveMessage(projectId, 'user', lastUser.parts ?? []);

  // 输入长度上限（防滥用）
  const lastUserText = (lastUser?.parts ?? [])
    .filter(
      (p): p is { type: 'text'; text: string } =>
        (p as { type?: string }).type === 'text',
    )
    .map((p) => p.text ?? '')
    .join('');
  if (lastUserText.length > 4000) {
    return c.json({ error: 'too_long', message: '输入过长（上限 4000 字）' }, 413);
  }

  // 取（或创建）该项目的沙箱工作区
  let ws;
  try {
    ws = await acquireWorkspace(projectId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('429') || msg.includes('busy')) {
      return c.json({ error: 'busy', message: '当前运行中的应用较多，请稍后再试' }, 503);
    }
    throw err;
  }

  const stream = createUIMessageStream({
    originalMessages: uiMessages,
    execute: async ({ writer }) => {
      const tools = createTools(getRuntime(), ws, (part) => writer.write(part as never));
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: await convertToModelMessages(uiMessages),
        tools,
        stopWhen: stepCountIs(30),
        maxRetries: 2,
        headers: {
          'x-opencode-session': projectId,
          'User-Agent': 'atoms-demo/1.0',
        },
        onError: ({ error }) => {
          console.error('[chat] stream error:', error);
        },
      });
      writer.merge(result.toUIMessageStream());
    },
    onEnd: async ({ messages }) => {
      const assistant = messages[messages.length - 1];
      if (assistant && assistant.role === 'assistant') {
        await saveMessage(projectId, 'assistant', assistant.parts).catch((err) =>
          console.error('[chat] save message error:', err),
        );
      }
      try {
        await snapshotProject(projectId);
      } catch (err) {
        console.error('[chat] snapshot error:', err);
      }
      await query('update projects set updated_at = now() where id = $1', [projectId]);
    },
    onError: (err) => {
      console.error('[chat] stream error:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (/MissingSessionID|401|403/i.test(msg)) {
        return '模型服务鉴权失败，请联系管理员。';
      }
      if (/rate|429|quota|额度/i.test(msg)) {
        return '模型服务繁忙或额度不足，请稍后重试。';
      }
      if (/ECONNRESET|fetch failed|stream ended|timeout/i.test(msg)) {
        return '与模型服务的连接中断，请重试。';
      }
      return '生成过程中出现错误，请重试。';
    },
  });

  return createUIMessageStreamResponse({ stream });
});
