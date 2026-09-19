import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModelUsage,
  type UIMessage,
} from 'ai';
import { Hono } from 'hono';

import { model, SYSTEM_PROMPT } from '../agent';
import { clearBusy, markBusy } from '../agent-busy';
import { requireUser } from '../auth';
import { config } from '../config';
import { currentPeriod, ensureGrant, spend } from '../credits';
import { computeCredits, getRates, pickUsage, roundCredits } from '../credits/pricing';
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
  credits?: number | null,
) {
  const r = await query<{ next: number }>(
    'select coalesce(max(seq), 0) + 1 as next from messages where project_id = $1',
    [projectId],
  );
  await query(
    'insert into messages (project_id, seq, role, parts, credits) values ($1, $2, $3, $4, $5)',
    [projectId, r.rows[0].next, role, JSON.stringify(parts), credits ?? null],
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

  // credits：先按周期发放，再校验余额（余额 ≤ 0 直接拒绝）
  const balance = await ensureGrant(user.id);
  if (!(balance > 0)) {
    return c.json(
      {
        error: 'insufficient_credits',
        message: '积分已用完，额度会在下个周期自动恢复',
        balance,
        period: currentPeriod(),
        monthlyGrant: config.creditsMonthlyGrant,
      },
      402,
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

  // 定价（失败会回退兜底费率，不阻塞生成）
  const rates = await getRates(config.llm.model);

  markBusy(projectId);
  setTimeout(() => clearBusy(projectId), 10 * 60 * 1000).unref();

  // 结算（一次性，onEnd / onError 都可能触发，用 memo 防重复扣）
  let usagePromise: PromiseLike<LanguageModelUsage> | null = null;
  let budgetExceeded = false;
  let settledCredits: number | null = null;
  let settling: Promise<number> | null = null;

  // 已完成步的用量累计：流被中断 / 重试导致拿不到整体 usage 时的兜底。
  // （重试只重跑当前步，已完成步会被保留；中断时这些步是真实消耗，不能白送）
  const steps = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  function settle(): Promise<number> {
    settling ??= (async () => {
      try {
        let total: LanguageModelUsage | null = null;
        try {
          total = usagePromise ? await usagePromise : null;
        } catch (err) {
          console.warn('[chat] 取整体 usage 失败:', (err as Error).message);
        }
        const picked = pickUsage(total, steps);
        if (!picked) return 0;
        if (picked.source === 'steps') {
          console.warn(
            `[chat] 用「已完成步」兜底结算：${steps.count} 步 / in ${steps.input} / out ${steps.output}`,
          );
        }
        const credits = roundCredits(computeCredits(picked.usage, rates));
        if (credits <= 0) return 0;
        await spend(user.id, credits, {
          projectId,
          ref: config.llm.model,
          meta: { budgetExceeded, usageSource: picked.source, steps: steps.count },
        });
        return credits;
      } catch (err) {
        console.error('[chat] credits 结算失败:', err);
        return 0;
      }
    })();
    return settling;
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
        // 逐步检查：累计消耗达到起始余额即优雅停止本轮循环
        stopWhen: [
          stepCountIs(30),
          ({ steps }) => {
            const used = roundCredits(
              steps.reduce((sum, s) => sum + computeCredits(s.usage, rates), 0),
            );
            if (used >= balance) {
              budgetExceeded = true;
              return true;
            }
            return false;
          },
        ],
        maxRetries: 2,
        headers: {
          'x-opencode-session': projectId,
          'User-Agent': 'atoms-demo/1.0',
        },
        onStepFinish: ({ usage }) => {
          steps.count += 1;
          steps.input += usage.inputTokens ?? 0;
          steps.output += usage.outputTokens ?? 0;
          steps.cacheRead += usage.inputTokenDetails?.cacheReadTokens ?? 0;
          steps.cacheWrite += usage.inputTokenDetails?.cacheWriteTokens ?? 0;
        },
        onError: ({ error }) => {
          console.error('[chat] stream error:', error);
        },
      });
      // AI SDK v7：`usage` 即「多步之和」（totalUsage 已废弃，是它的别名）
      usagePromise = result.usage;

      // 手动转发：等内层流结束、结算完成后，再补发一条 data-credits
      const reader = result.toUIMessageStream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value as never);
        }
      } finally {
        settledCredits = await settle();
        if (settledCredits > 0) {
          const remaining = await ensureGrant(user.id).catch(() => 0);
          writer.write({
            type: 'data-credits',
            id: 'credits',
            data: {
              credits: settledCredits,
              balance: remaining,
              budgetExceeded,
            },
          } as never);
        }
      }
    },
    onEnd: async ({ messages }) => {
      const assistant = messages[messages.length - 1];
      if (assistant && assistant.role === 'assistant') {
        await saveMessage(projectId, 'assistant', assistant.parts, settledCredits).catch(
          (err) => console.error('[chat] save message error:', err),
        );
      }
      try {
        await snapshotProject(projectId);
      } catch (err) {
        console.error('[chat] snapshot error:', err);
      }
      await query('update projects set updated_at = now() where id = $1', [projectId]);
      clearBusy(projectId);
    },
    onError: (err) => {
      console.error('[chat] stream error:', err);
      clearBusy(projectId);
      // 上游中断也要按实际用量结算（若 onEnd 未触发）
      settle().catch((e) => console.error('[chat] 中断结算失败:', e));
      // 上游中断时 onEnd 的快照可能早于工具写入完成 —— 延迟再补一次，
      // 否则这一轮写进沙箱的文件会没落库（表现为文件树为空）。
      setTimeout(() => {
        snapshotProject(projectId)
          .then((f) =>
            console.log(
              `[chat] 中断补偿快照 ${projectId}: ${Object.keys(f).length} 个文件`,
            ),
          )
          .catch((e) => console.error('[chat] 中断补偿快照失败:', e));
      }, 3000);
      const msg = err instanceof Error ? err.message : String(err);
      if (/MissingSessionID|401|403/i.test(msg)) {
        return '模型服务鉴权失败，请联系管理员。';
      }
      if (/insufficient_credits/i.test(msg)) {
        return '积分已用完，额度会在下个周期自动恢复。';
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
