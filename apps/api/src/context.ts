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

export function pruneForModel(messages: UIMessage[]): UIMessage[] {
  if (messages.length <= KEEP_RECENT) return messages;
  const cut = messages.length - KEEP_RECENT;
  return messages.map((m, i) => {
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
        typeof v === 'string' && v.length > MAX_TOOL_CHARS
          ? `${v.slice(0, MAX_TOOL_CHARS)}\n…（历史输出已截断）`
          : v;

      const clipInput = (v: unknown) =>
        typeof v === 'string' && v.length > MAX_TOOL_INPUT_CHARS
          ? `${v.slice(0, MAX_TOOL_INPUT_CHARS)}…（历史入参已截断）`
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
