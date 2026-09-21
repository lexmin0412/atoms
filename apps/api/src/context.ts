import type { UIMessage } from 'ai';

/**
 * 送给模型的历史裁剪。
 *
 * 为什么必须做：我们曾把完整终端输出、整份文件内容、思考过程全部留在历史里并每轮重发，
 * 单条消息可达 237KB —— 请求越来越慢、上游频繁断流（表现为「跑着跑着自己停了」）。
 *
 * 规则：
 * - 最近 KEEP_RECENT 条原样保留（当前工作状态都在这里）
 * - 更早的消息：工具输出截断到 MAX_TOOL_CHARS；丢弃 UI-only 的 data-* 零件与思考过程
 * - 工具调用与其结果的配对**不能拆散**（拆了上游会报错），只截断内容
 */
const KEEP_RECENT = 2;
/** 历史里工具【输出】保留的长度 */
const MAX_TOOL_CHARS = 1500;
/**
 * 历史里工具【入参】保留的长度。
 * 入参往往比输出还大（`write_file` 的入参就是整个文件内容），
 * 而旧轮次的入参对继续干活没有价值 —— 文件本身在磁盘上，需要时 read_file 即可。
 */
const MAX_TOOL_INPUT_CHARS = 600;

type LoosePart = { type?: string; output?: unknown } & Record<string, unknown>;

export interface PruneOptions {
  /** 末尾原样保留几条 */
  keepRecent?: number;
  /** 历史里工具【输出】保留长度 */
  maxToolChars?: number;
  /** 历史里工具【入参】保留长度 */
  maxToolInputChars?: number;
}

/**
 * 修复历史里的「悬空工具调用」。
 *
 * 上一轮被中断时（用户点停止 / 沙箱不可用 / 上游断流），助手消息会停在
 * `state: 'input-available'` 的工具调用上，没有任何结果。这段历史一旦落库，
 * 之后每一轮都会以同一句话失败：
 *   `Tool result is missing for tool call call_xxx`（AI SDK 校验）
 * 用户点「重试」也没用 —— 坏消息是持久的（真实事故：同一项目连续 3 次重试全失败）。
 *
 * 处理：把没有结果的工具调用改写成 `output-error`（带上原因）。配对成立，
 * 模型也知道那次工具没跑成，可以自己决定重试。
 */
export function repairDanglingToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    let changed = false;
    const parts = (m.parts as unknown as LoosePart[]).map((p) => {
      const toolCallId = p.toolCallId;
      if (typeof toolCallId !== 'string' || !toolCallId) return p;
      const state = p.state;
      // 有结果的（成功 / 失败 / 被拒绝）本来就能配对，不动
      if (
        state === 'output-available' ||
        state === 'output-error' ||
        state === 'output-denied'
      ) {
        return p;
      }
      changed = true;
      return {
        ...p,
        state: 'output-error',
        input: p.input ?? {},
        output: undefined,
        errorText: '上一轮生成被中断，这次工具没有执行完（可以让 Agent 重试）。',
      };
    });
    return changed ? ({ ...m, parts } as unknown as UIMessage) : m;
  });
}

/** 中断时落库的零件会停在 streaming：这类「半截零件」不能原样回灌给模型 */
function isUnfinished(state: unknown): boolean {
  return state === 'streaming' || state === 'input-streaming';
}

/**
 * 修复中断留下的「半截零件」。
 *
 * 真实事故：用户点停止 / 上游断流后，助手消息里会留下 `reasoning` 零件，
 * state 停在 `streaming`。下一轮把它当正常上下文发上去，模型会以为自己的推理
 * 还没写完，于是**继续在推理块里写代码**（实测 delta 里全是 `const x = ...`），
 * 推理无限膨胀 → 上游流被截断 → 报 `Failed to process successful response`；
 * 而这次失败又留下新的半截推理 —— 恶性循环，表现为「跑几下就报错，重试也没用」。
 *
 * 处理：半截推理直接丢弃（模型不需要、且会诱发续写）；半截文本保留内容但标记完成。
 */
export function repairInterruptedParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    const parts = (m.parts as unknown as LoosePart[]) ?? [];
    let changed = false;
    const next: LoosePart[] = [];
    for (const p of parts) {
      const type = p.type ?? '';
      if (type === 'reasoning' && isUnfinished(p.state)) {
        changed = true;
        continue;
      }
      if (type === 'text' && isUnfinished(p.state)) {
        changed = true;
        next.push({ ...p, state: 'done' });
        continue;
      }
      next.push(p);
    }
    return changed ? ({ ...m, parts: next } as unknown as UIMessage) : m;
  });
}

/** 历史修复总入口：半截零件 + 悬空工具调用（送模型、渲染历史都要先过这一层） */
export function repairHistory(messages: UIMessage[]): UIMessage[] {
  return repairDanglingToolCalls(repairInterruptedParts(messages));
}

/** 推理零件一律不进模型上下文（UI-only），顺带避免续写半截推理 */
function stripReasoning(m: UIMessage): UIMessage {
  const parts = m.parts as unknown as LoosePart[];
  if (!parts?.some((p) => (p.type ?? '') === 'reasoning')) return m;
  return {
    ...m,
    parts: parts.filter((p) => (p.type ?? '') !== 'reasoning'),
  } as unknown as UIMessage;
}

/** 助手回合里是否还有对模型有意义的内容（文本 / 工具调用） */
function hasModelContent(m: UIMessage): boolean {
  const parts = (m.parts as unknown as LoosePart[]) ?? [];
  return parts.some((p) => {
    const type = p.type ?? '';
    if (type === 'text') return Boolean(String(p.text ?? '').trim());
    return type === 'dynamic-tool' || type.startsWith('tool-');
  });
}

/**
 * 丢掉「空助手回合」。
 *
 * 中断 + 只剥推理之后，历史里会剩下几条**只有 step-start 的助手消息**。
 * 模型看到「助手什么都没说」会觉得状态异常，进而把推理当草稿纸狂写（实测 5 万字），
 * 最终把上游流撑断。这类回合对模型没有任何信息量，直接丢掉。
 */
export function dropEmptyAssistantTurns(messages: UIMessage[]): UIMessage[] {
  const out = messages.filter((m) => m.role !== 'assistant' || hasModelContent(m));
  return out.length === messages.length ? messages : out;
}

export function pruneForModel(
  messages: UIMessage[],
  options: PruneOptions = {},
): UIMessage[] {
  const keepRecent = options.keepRecent ?? KEEP_RECENT;
  const maxToolChars = options.maxToolChars ?? MAX_TOOL_CHARS;
  const maxToolInputChars = options.maxToolInputChars ?? MAX_TOOL_INPUT_CHARS;
  // 注意：必须对【所有】消息剥掉推理 —— 最近窗口里的半截推理正是故障源头
  const stripped = dropEmptyAssistantTurns(messages.map(stripReasoning));
  if (stripped.length <= keepRecent) return stripped;
  const cut = stripped.length - keepRecent;
  return stripped.map((m, i) => {
    if (i >= cut) return m;
    // 没改动就保留原对象（引用不变，便于判断"这条被裁过吗"）
    let changed = false;
    const parts = (m.parts as unknown as LoosePart[]).flatMap((p): LoosePart[] => {
      const type = p.type ?? '';
      if (type.startsWith('data-')) {
        changed = true;
        return []; // UI-only（终端流、积分、技能状态）
      }
      if (type === 'reasoning') {
        changed = true;
        return []; // 思考过程对继续做事没有价值
      }
      const isTool = type === 'dynamic-tool' || type.startsWith('tool-');
      if (!isTool) return [p];

      const clip = (v: unknown) =>
        typeof v === 'string' && v.length > maxToolChars
          ? `${v.slice(0, maxToolChars)}\n…（历史输出已截断）`
          : v;

      const clipInput = (v: unknown) =>
        typeof v === 'string' && v.length > maxToolInputChars
          ? `${v.slice(0, maxToolInputChars)}…（历史入参已截断）`
          : v;
      const shrink = (
        obj: unknown,
        clip: (v: unknown) => unknown,
      ): Record<string, unknown> | undefined => {
        if (typeof obj === 'string') return undefined;
        if (!obj || typeof obj !== 'object') return undefined;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj as Record<string, unknown>))
          out[k] = clip(v);
        return out;
      };

      const next: LoosePart = { ...p };
      if (typeof p.input === 'string') {
        if (clipInput(p.input) !== p.input) changed = true;
        next.input = clip(p.input);
      } else {
        const input = shrink(p.input, clipInput);
        if (input) {
          if (JSON.stringify(input) !== JSON.stringify(p.input)) changed = true;
          next.input = input;
        }
      }
      if (typeof p.output === 'string') {
        if (clip(p.output) !== p.output) changed = true;
        next.output = clip(p.output);
      } else {
        const output = shrink(p.output, clip);
        if (output) {
          if (JSON.stringify(output) !== JSON.stringify(p.output)) changed = true;
          next.output = output;
        }
      }
      return [next];
    });
    return changed ? ({ ...m, parts } as unknown as UIMessage) : m;
  });
}
