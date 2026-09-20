import { generateText, type UIMessage } from 'ai';

import { model } from './agent';
import { query } from './db';
import { logErr } from './redact';

/**
 * 上下文压缩。
 *
 * 只有裁剪（pruneForModel）不够：它把旧内容**截断**而不是**归纳**，
 * 且"最近窗口"本身也会膨胀（单轮 30 次工具调用 + 大文件可达十几万 token）。
 * 这里再加一层：
 *
 * 1. **软上限预算**：模型窗口很大（1M），但上游在 ~200k token 附近就容易断流，
 *    所以取一个平台软上限（CONTEXT_SOFT_LIMIT，默认 200k）作为实际约束。
 * 2. **阈值触发归纳**：估算上下文超过软上限的 80% 时，把「尾部保留条数」之前的历史
 *    交给模型归纳成一段摘要（含已有的旧摘要 → 增量更新），存到项目上；
 *    模型看到的是「摘要 + 最近若干条原样消息」，历史仍完整留在库里供人查看。
 * 3. 压缩失败不阻塞对话：退回纯裁剪。
 */

/** 触发压缩的占比 */
export const COMPRESS_RATIO = 0.8;
/** 压缩后尾部保留几条「原样」消息（保证连贯性） */
export const KEEP_TAIL = 6;
/** 摘要长度上限（字符） */
const SUMMARY_MAX_CHARS = 1200;

/**
 * token 计数：用业界标准 BPE（gpt-tokenizer 的 o200k_base）。
 *
 * 为什么不是自己数：手搓的「字符数 / 系数」对混合内容（中文 + 代码 + JSON）误差很大，
 * 曾把 234k 真实 token 估成 92k，导致压缩根本不触发。
 * 标定：中文 1 字 ≈ 1 token（o200k 与实测一致；cl100k 会翻倍），英文/代码约 3~4 字符 1 token。
 *
 * 懒加载 + 兜底：库缺失（忘了装依赖）时退回启发式，绝不让计数失败影响对话。
 */
let tokenizer: Promise<{ countTokens: (text: string) => number } | null> | null = null;

function loadTokenizer() {
  tokenizer ??= import('gpt-tokenizer/encoding/o200k_base')
    .then((m) => ({ countTokens: m.countTokens }))
    .catch(() => null);
  return tokenizer;
}

/** 兜底估算：中文约 1 字 1 token，其余约 4 字符 1 token */
function heuristicTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch >= '\u2e80') cjk += 1;
    else other += 1;
  }
  return Math.round(cjk / 1.1 + other / 4);
}

export async function estimateTokens(value: unknown): Promise<number> {
  if (value === null || value === undefined || value === '') return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const tk = await loadTokenizer();
  if (!tk) return heuristicTokens(text);
  try {
    return tk.countTokens(text);
  } catch {
    return heuristicTokens(text);
  }
}

/** 是否需要压缩（纯函数，便于测试） */
export function shouldCompress(input: {
  estimatedTokens: number;
  lastInputTokens: number | null;
  softLimit: number;
  messageCount: number;
  /** 已有摘要覆盖了多少条 */
  summaryCount?: number;
  force?: boolean;
}): boolean {
  if (input.force === true) return true;
  const compressible = Math.max(0, input.messageCount - KEEP_TAIL);
  if (compressible < 2) return false;
  const threshold = input.softLimit * COMPRESS_RATIO;
  const over =
    input.estimatedTokens >= threshold || (input.lastInputTokens ?? 0) >= threshold;
  if (!over) return false;
  // 摘要已覆盖到「压缩线」附近时不必每轮都重算：
  // 落后部分（≤ KEEP_TAIL 条）本来就会原样保留；只有真超软上限才立刻更新。
  const delta = compressible - (input.summaryCount ?? 0);
  if (delta < KEEP_TAIL && input.estimatedTokens < input.softLimit) return false;
  return true;
}

interface ProjectContextRow {
  context_summary: string | null;
  context_summary_count: number;
  last_input_tokens: number | null;
}

export interface CompressResult {
  /** 是否有新摘要产生 */
  compressed: boolean;
  /** 送给模型的摘要文本（含历史） */
  summary: string | null;
  /** 摘要覆盖了多少条历史消息 */
  coveredCount: number;
  /** 估算的上下文大小（token） */
  estimatedTokens: number;
}

export async function loadContextState(projectId: string): Promise<ProjectContextRow> {
  const r = await query<ProjectContextRow>(
    'select context_summary, context_summary_count, last_input_tokens from projects where id = $1',
    [projectId],
  );
  return (
    r.rows[0] ?? {
      context_summary: null,
      context_summary_count: 0,
      last_input_tokens: null,
    }
  );
}

/** 记录本轮真实输入 token（给「上下文用量」与下次触发判断用） */
export async function saveInputTokens(projectId: string, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  await query('update projects set last_input_tokens = $2 where id = $1', [
    projectId,
    Math.round(tokens),
  ]).catch((err) => logErr('[context] 记录 inputTokens 失败:', err));
}

const SUMMARY_PROMPT = `你在为一个「对话即应用」的 AI 工程师压缩上下文。
把下面的历史对话归纳成一段**给模型自己看的交接说明**，要求：
- 只写事实，不要客套话、不要复述原文；
- 必须包含：用户目标与已确认的要求、已经完成的工作、关键文件与其作用（保留准确路径）、
  还没做完的事、已知的坑或约束；
- 用简洁的中文短句/列表，总长不超过 ${SUMMARY_MAX_CHARS} 字；
- 如果给了「已有摘要」，在它基础上更新（保留仍有效的信息，补充新进展），不要丢掉已有结论。`;

/**
 * 需要时压缩历史。调用方拿到 summary 后应：
 * 把它作为参考材料注入，并且只把 `messages.slice(coveredCount)` 送进裁剪。
 */
export async function maybeCompress(opts: {
  projectId: string;
  messages: UIMessage[];
  softLimit: number;
  force?: boolean;
}): Promise<CompressResult> {
  const { projectId, messages, softLimit, force } = opts;
  const state = await loadContextState(projectId);

  // 尾部要保留，所以可压缩的部分是前面这些
  const compressible = Math.max(0, messages.length - KEEP_TAIL);
  const covered = Math.min(state.context_summary_count, compressible);
  // 判断要按【实际会发给模型的量】算：已有摘要 + 摘要之后的部分。
  // 若按全量历史算，一旦超过软上限就会每轮都重新归纳（白花调用）。
  const effective = state.context_summary
    ? await estimateTokens([state.context_summary, ...messages.slice(covered)])
    : await estimateTokens(messages);
  const need = shouldCompress({
    estimatedTokens: effective,
    lastInputTokens: state.last_input_tokens,
    softLimit,
    messageCount: messages.length,
    summaryCount: state.context_summary_count,
    force,
  });
  if (!need) {
    return {
      compressed: false,
      summary: state.context_summary,
      coveredCount: covered,
      estimatedTokens: effective,
    };
  }

  // 已有摘要覆盖了前 N 条 → 只归纳「增量」+ 旧摘要
  const from = Math.min(state.context_summary_count, compressible);
  const delta = messages.slice(from, compressible);
  if (delta.length === 0) {
    return {
      compressed: false,
      summary: state.context_summary,
      coveredCount: from,
      estimatedTokens: effective,
    };
  }

  try {
    const { text } = await generateText({
      model,
      system: SUMMARY_PROMPT,
      prompt:
        (state.context_summary ? `【已有摘要】\n${state.context_summary}\n\n` : '') +
        `【新增历史】\n${JSON.stringify(delta).slice(0, 120_000)}`,
      maxRetries: 1,
      headers: {
        'x-opencode-session': projectId,
        'User-Agent': 'atoms-demo/1.0',
      },
    });
    const summary = text.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!summary) throw new Error('摘要为空');
    await query(
      'update projects set context_summary = $2, context_summary_count = $3 where id = $1',
      [projectId, summary, compressible],
    );
    console.log(
      `[context] 已压缩 ${projectId}: 覆盖 ${compressible} 条（压缩前将发送 ${effective} tokens → 摘要 ${summary.length} 字）`,
    );
    return {
      compressed: true,
      summary,
      coveredCount: compressible,
      estimatedTokens: effective,
    };
  } catch (err) {
    logErr(`[context] 压缩失败（改用纯裁剪）${projectId}:`, err);
    return {
      compressed: false,
      summary: state.context_summary,
      coveredCount: from,
      estimatedTokens: effective,
    };
  }
}
