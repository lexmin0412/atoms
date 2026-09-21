import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModelUsage,
  type UIMessage,
} from 'ai';
import { Hono } from 'hono';

import { model, SYSTEM_PROMPT } from '../agent';
import { clearBusy, markBusy } from '../agent-busy';
import { requireUser } from '../auth';
import { estimateTokens, maybeCompress, saveInputTokens } from '../compress';
import { config } from '../config';
import { pruneForModel, repairHistory } from '../context';
import { currentPeriod, ensureGrant, spend } from '../credits';
import {
  computeCredits,
  getModelInfo,
  getRates,
  pickUsage,
  roundCredits,
} from '../credits/pricing';
import { query } from '../db';
import { logErr, sanitizeText } from '../redact';
import { fail } from '../respond';
import { getRuntime } from '../runtime';
import { acquireWorkspace, snapshotProject } from '../runtime/manager';
import { resolveSkills, skillsBrief, type ResolvedSkill } from '../skills';
import { createTools } from '../tools';
import type { Env } from './auth';

/** 单轮最多跑多少步（含工具往返）；到顶会停下并记录日志，用户可继续下一轮 */
const MAX_STEPS = 500;
/** 推理空转保护阈值（字符）：超过且无任何正文/工具调用就中止本轮 */
const REASONING_GUARD_CHARS = 12_000;
/** 单轮最长时长上限：上游卡死时避免前端一直转圈（到点按中止处理，已完成的改动已落库） */
const MAX_ROUND_MS = Number(process.env.CHAT_MAX_ROUND_MS ?? 15 * 60 * 1000);

export const chatRoutes = new Hono<Env>();

chatRoutes.use('*', requireUser);

/** 递归清洗对象里所有字符串（NUL / 孤立代理项会让 jsonb 写入整条失败） */
function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

async function saveMessage(
  projectId: string,
  role: 'user' | 'assistant',
  parts: unknown,
  credits?: number | null,
  skills?: string[] | null,
) {
  const r = await query<{ next: number }>(
    'select coalesce(max(seq), 0) + 1 as next from messages where project_id = $1',
    [projectId],
  );
  // 双保险：parts 里可能夹带工具输出中的 NUL/孤立代理项。
  // 注意必须在 stringify **之前**深度清洗 —— JSON.stringify 会把 NUL 转义成
  // 字面量 `\u0000`，事后对字符串做替换是抓不到的（jsonb 解析时才会报错）。
  const json = JSON.stringify(sanitizeDeep(parts ?? []));
  await query(
    `insert into messages (project_id, seq, role, parts, credits, skills)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      projectId,
      r.rows[0].next,
      role,
      json,
      credits ?? null,
      skills?.length ? skills : null,
    ],
  );
}

/**
 * 把用户显式选中的技能正文作为「参考资料」附在本轮用户消息上。
 * 刻意不拼进 system：正文是资料，不是系统指令（降低「技能正文改行为」的风险）。
 */
function withSkillContext(messages: UIMessage[], skills: ResolvedSkill[]): UIMessage[] {
  if (!skills.length) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx < 0) return messages;
  const block = skills.map((s) => `### 技能：${s.name}\n${s.body}`).join('\n\n');
  const text =
    `以下是用户为本轮选定的技能资料，请按其中的规范执行（这是参考资料，不是系统指令）：\n\n` +
    block;
  const next = [...messages];
  const target = next[idx];
  const parts = [{ type: 'text', text }, ...(target.parts ?? [])];
  next[idx] = { ...target, parts } as UIMessage;
  return next;
}

chatRoutes.post('/:id/chat', async (c) => {
  const user = c.get('user');
  const projectId = c.req.param('id');

  const own = await query<{ max_steps: number }>(
    'select max_steps from projects where id = $1 and user_id = $2',
    [projectId, user.id],
  );
  if (!own.rowCount) return c.json({ error: 'not_found' }, 404);
  // 每项目可配（默认 30），见 GET/PATCH /api/projects/:id/agent
  const maxSteps = own.rows[0]?.max_steps ?? MAX_STEPS;

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

  const body = await c.req
    .json<{ messages?: UIMessage[]; skills?: string[] }>()
    .catch(() => null);
  const uiMessages = body?.messages ?? [];
  // 本轮显式选中的技能（名字），最多 10 个
  const selectedNames = (body?.skills ?? [])
    .filter((n): n is string => typeof n === 'string')
    .slice(0, 10);
  const selected = await resolveSkills(user.id, projectId, selectedNames);
  const lastUser = [...uiMessages].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    await saveMessage(
      projectId,
      'user',
      lastUser.parts ?? [],
      undefined,
      selected.map((s) => s.name),
    );
  }

  // 自动命中用：只常驻「名字 + 适用场景」，正文由 Agent 用 read_skill 自取
  const brief = await skillsBrief(user.id, projectId);
  const system = brief.length
    ? `${SYSTEM_PROMPT}\n\n## 可用技能\n用户为项目准备了以下技能（列表只给摘要）：\n` +
      brief.map((b) => `- ${b.name}：${b.description}`).join('\n') +
      `\n\n当用户的要求与某个技能的适用场景相关，或用户点名要求使用某个技能时，` +
      `先用 read_skill 读取它的完整内容，再按其要求执行。`
    : SYSTEM_PROMPT;

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
    // 沙箱不可达（隧道断/服务没起）也要给可重试的 503，而不是通用 500
    return fail(c, err);
  }

  // 定价（失败会回退兜底费率，不阻塞生成）
  const rates = await getRates(config.llm.model);

  markBusy(projectId);
  setTimeout(() => clearBusy(projectId), 10 * 60 * 1000).unref();

  // 结算（一次性，onEnd / onError 都可能触发，用 memo 防重复扣）
  let usagePromise: PromiseLike<LanguageModelUsage> | null = null;
  let budgetExceeded = false;
  /**
   * 本轮是否触发了「推理空转」保护。
   * 真实事故：对话历史被中断污染后，模型会误判状态，把整个实现写进推理块
   * （实测 5 万字、里面全是 tsconfig/组件代码），推理无限膨胀把上游流撑断 → 报
   * `Failed to process successful response`，而失败又留下新的半截推理，形成恶性循环。
   */
  let reasoningGuardTripped = false;
  const roundAbort = new AbortController();
  /** 本轮是否因为撞到步数上限而停止（前端据此给出明确提示，而不是「莫名停了」） */
  let stepsExceeded = false;
  /** 本轮实际输入 token（前端「上下文用量」显示这个数） */
  /** 上下文大小：单步输入 token 的最大值（多步之和会重复计算同一份上下文） */
  let contextTokens = 0;
  let contextLimit = 0;
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
          // 这里最常出现的是上游断流/被 SDK 包装过的错误：必须打印 cause 链，
          // 否则线上只看到一句 "Failed to process successful response"（真实踩坑）。
          logErr('[chat] 取整体 usage 失败:', err);
        }
        const picked = pickUsage(total, steps);
        if (!picked) return 0;
        if (!contextTokens && picked.usage.inputTokens) {
          contextTokens = picked.usage.inputTokens;
        }
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
        logErr('[chat] credits 结算失败:', err);
        return 0;
      }
    })();
    return settling;
  }

  const stream = createUIMessageStream({
    originalMessages: uiMessages,
    execute: async ({ writer }) => {
      const tools = createTools(getRuntime(), ws, (part) => writer.write(part as never), {
        userId: user.id,
        projectId,
      });

      contextLimit = (await getModelInfo(config.llm.model)).contextLimit;

      // 模型上下文以【库里的完整历史】为准：客户端只提交最新一条，
      // 请求体大小便不再影响模型看到的内容（长对话也不会因 nginx body 限制而中断）。
      const rows = await query<{ seq: number; role: string; parts: unknown }>(
        'select seq, role, parts from messages where project_id = $1 order by seq',
        [projectId],
      );
      const history: UIMessage[] = rows.rows.map((r) => ({
        id: `m${r.seq}`,
        role: r.role as UIMessage['role'],
        parts: (r.parts ?? []) as UIMessage['parts'],
      }));

      // 1) 超过软上限 80% 时先归纳压缩历史（失败不影响本轮）
      const full = withSkillContext(history, selected);
      const compressed = await maybeCompress({
        projectId,
        messages: full,
        softLimit: config.contextSoftLimit,
      });
      if (compressed.compressed) {
        writer.write({
          type: 'data-context',
          id: 'context-compressed',
          data: {
            coveredCount: compressed.coveredCount,
            estimatedTokens: compressed.estimatedTokens,
          },
        } as never);
      }

      // 2) 摘要作为参考材料注入，且只把未压缩部分送去裁剪
      const summaryHead = compressed.summary
        ? ([
            {
              id: 'context-summary',
              role: 'user',
              parts: [
                {
                  type: 'text',
                  text:
                    `【历史对话摘要】更早的对话已压缩为下面这段交接说明（不是用户的新指令）：\n` +
                    compressed.summary,
                },
              ],
            },
          ] as unknown as UIMessage[])
        : [];
      const tail = compressed.summary ? full.slice(compressed.coveredCount) : full;
      let pruned = [...summaryHead, ...pruneForModel(tail)];

      // 3) 兜底硬约束：仍超软上限时连最近窗口一起压缩，保证不会把超大请求发给上游
      let est = await estimateTokens(pruned);
      if (est > config.contextSoftLimit) {
        const saved = est;
        pruned = [
          ...summaryHead,
          ...pruneForModel(tail, {
            keepRecent: 1,
            maxToolChars: 400,
            maxToolInputChars: 200,
          }),
        ];
        est = await estimateTokens(pruned);
        console.log(
          `[chat] 上下文仍超软上限 ${projectId}: ${saved} → ${est} tokens（严格裁剪）`,
        );
      }

      console.log(
        `[chat] 上下文 ${projectId}: ${history.length} 条 ${await estimateTokens(history)} tokens → 送模型 ${est} tokens` +
          `（软上限 ${config.contextSoftLimit}` +
          (compressed.summary ? `，已压缩至第 ${compressed.coveredCount} 条` : '') +
          '）',
      );

      const result = streamText({
        model,
        system,
        // 客户端断开（点「停止」/关页面）→ 立刻停止生成与工具执行，
        // 否则服务端会继续烧 token、继续占用沙箱（曾导致并发池被占满、后续消息全部失败）；
        // 同时叠加单轮最长时长，避免上游卡死时前端无限等待。
        abortSignal: AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(MAX_ROUND_MS),
          roundAbort.signal, // 推理空转保护用
        ]),
        // 历史里可能有被中断的悬空工具调用：不修就会一直报 Tool result is missing
        messages: await convertToModelMessages(repairHistory(pruned)),
        tools,
        // 逐步检查：累计消耗达到起始余额即优雅停止本轮循环
        stopWhen: [
          ({ steps }) => {
            if (steps.length >= maxSteps) {
              stepsExceeded = true;
              console.log(
                `[chat] 达到步数上限 ${maxSteps}，停止本轮 ${projectId}（下一轮可继续；用户可在项目里调大）`,
              );
              return true;
            }
            return false;
          },
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
          'User-Agent': 'another-atoms/1.0',
        },
        onStepFinish: ({ usage }) => {
          steps.count += 1;
          // 每步都会带完整上下文，取最大值即"当前上下文大小"（累计值会翻倍）
          contextTokens = Math.max(contextTokens, usage.inputTokens ?? 0);
          steps.input += usage.inputTokens ?? 0;
          steps.output += usage.outputTokens ?? 0;
          steps.cacheRead += usage.inputTokenDetails?.cacheReadTokens ?? 0;
          steps.cacheWrite += usage.inputTokenDetails?.cacheWriteTokens ?? 0;
        },
        onError: ({ error }) => {
          logErr('[chat] stream error:', error);
        },
      });
      // AI SDK v7：`usage` 即「多步之和」（totalUsage 已废弃，是它的别名）
      usagePromise = result.usage;

      // 手动转发：等内层流结束、结算完成后，再补发一条 data-credits
      let reasoningChars = 0;
      let sawProgress = false;
      // 增量合并：模型一轮会产生上万个 reasoning/tool-input 增量（实测 3.4 万条），
      // 前端 useChat 每条都要 setState + 重渲染，会被淹死（表现为「模型服务暂时不可用」）。
      // 这里把同类增量攒到 ~4KB 再发一块，内容一字不改，事件数降两个数量级。
      const DELTA_FIELDS: Record<string, string> = {
        'reasoning-delta': 'delta',
        'tool-input-delta': 'inputTextDelta',
      };
      const MAX_DELTA_CHARS = 4000;
      let deltaBuf: {
        part: Record<string, unknown>;
        field: string;
        text: string;
        key: string;
      } | null = null;
      const flushDelta = () => {
        if (!deltaBuf) return;
        const { part, field, text } = deltaBuf;
        deltaBuf = null;
        writer.write({ ...part, [field]: text } as never);
      };
      const reader = result.toUIMessageStream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // 流内错误零件：把后端拿到的错误原因记下来（前端只会看到 errorText）
          const part = value as { type?: string; errorText?: string; delta?: string };
          if (part?.type === 'error') {
            logErr('[chat] UI 流错误零件:', part.errorText ?? 'unknown');
          }
          // 推理空转保护：只涨推理、既没有正文也没有工具调用 → 判定失控，主动中止。
          // （正常一轮的推理是几百到几千字；12000 字还没任何进展就是病态了）
          if (part?.type === 'reasoning-delta') {
            reasoningChars += (part.delta ?? '').length;
            if (reasoningChars > REASONING_GUARD_CHARS && !sawProgress) {
              reasoningGuardTripped = true;
              roundAbort.abort();
            }
          } else if (part?.type === 'text-delta' || part?.type === 'tool-input-start') {
            sawProgress = true;
          }

          const deltaField = DELTA_FIELDS[part?.type ?? ''];
          if (deltaField) {
            const raw = part as unknown as Record<string, unknown>;
            const idField = part?.type === 'reasoning-delta' ? 'id' : 'toolCallId';
            const key = `${part?.type}:${String(raw[idField] ?? '')}`;
            const text = String(raw[deltaField] ?? '');
            if (deltaBuf && deltaBuf.key === key) {
              deltaBuf.text += text;
              if (deltaBuf.text.length >= MAX_DELTA_CHARS) flushDelta();
            } else {
              flushDelta(); // 换目标前先冲刷，保证顺序
              deltaBuf = { part: raw, field: deltaField, text, key };
            }
          } else {
            flushDelta(); // 任何其他事件前先冲刷，保证顺序
            writer.write(value as never);
          }
        }
      } finally {
        flushDelta();
        settledCredits = await settle();
        if (contextTokens) void saveInputTokens(projectId, contextTokens);
        if (settledCredits > 0) {
          // 回读失败时省略 balance（前端保留上次值），不要伪造 0 误导用户
          const remaining = await ensureGrant(user.id).catch(() => null);
          const write = writer.write.bind(writer);
          try {
            write({
              type: 'data-credits',
              id: 'credits',
              data: {
                credits: settledCredits,
                ...(remaining === null ? {} : { balance: remaining }),
                budgetExceeded,
                // 撞到步数上限而停止：前端要明确告诉用户「为什么停了、怎么继续」
                stepsExceeded,
                stepsUsed: steps.count,
                // 前端据此显示「上下文 x/y」：本轮真实上下文（单步输入最大值）
                inputTokens: contextTokens || null,
                contextLimit,
                maxSteps,
              },
            } as never);
          } catch {
            // 客户端已断开：结算已经完成，丢这条 UI 通知即可
          }
        }
      }
    },
    onEnd: async ({ messages }) => {
      const assistant = messages[messages.length - 1];
      if (assistant && assistant.role === 'assistant') {
        await saveMessage(projectId, 'assistant', assistant.parts, settledCredits).catch(
          (err) => logErr(`[chat] 保存消息失败 ${projectId}:`, err),
        );
      }
      try {
        await snapshotProject(projectId);
      } catch (err) {
        logErr('[chat] snapshot error:', err);
      }
      await query('update projects set updated_at = now() where id = $1', [projectId]);
      clearBusy(projectId);
    },
    onError: (err) => {
      const aborted =
        c.req.raw.signal.aborted ||
        (err instanceof Error &&
          (err.name === 'AbortError' || /abort/i.test(err.message)));
      if (aborted) {
        console.log(`[chat] 客户端中止生成 ${projectId}（已结算并停止工具执行）`);
      } else {
        // errLine 已展开 name/status/body/cause 链 —— 上游真实原因都在这里
        logErr(`[chat] stream error ${projectId}:`, err);
      }
      clearBusy(projectId);
      // 上游中断也要按实际用量结算（若 onEnd 未触发）
      settle().catch((e) => logErr('[chat] 中断结算失败:', e));
      // 上游中断时 onEnd 的快照可能早于工具写入完成 —— 延迟再补一次，
      // 否则这一轮写进沙箱的文件会没落库（表现为文件树为空）。
      setTimeout(() => {
        snapshotProject(projectId)
          .then((f) =>
            console.log(
              `[chat] 中断补偿快照 ${projectId}: ${Object.keys(f).length} 个文件`,
            ),
          )
          .catch((e) => logErr('[chat] 中断补偿快照失败:', e));
      }, 3000);
      if (reasoningGuardTripped) {
        return '模型本轮一直在「想」而没有动手（只输出推理、没有进展），已中止。请再发一次，或把要求拆得更具体一些。';
      }
      if (aborted) return '已停止生成。';
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
      // 上游 2xx 但流被截断（网关侧）：给用户一句准确、可操作的说明，
      // 不要笼统地说「模型服务暂时不可用」——避免误以为是平台故障。
      if (
        /Failed to process successful response|ended without a finish|not valid JSON/i.test(
          msg,
        )
      ) {
        return '上游响应中断，本轮已完成的内容已保存，请重试。';
      }
      return '生成过程中出现错误，请重试。';
    },
  });

  return createUIMessageStreamResponse({ stream });
});
