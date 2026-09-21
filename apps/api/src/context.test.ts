import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  dropEmptyAssistantTurns,
  pruneForModel,
  repairDanglingToolCalls,
  repairInterruptedParts,
} from './context';

/** 造一条助手消息：一次工具调用 + 一段文本 */
function assistant(toolOutput: string, text = 'done'): UIMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text },
      {
        type: 'dynamic-tool',
        toolName: 'run_command',
        toolCallId: 'c1',
        state: 'output-available',
        input: { cmd: 'pnpm build' },
        output: { cmd: 'pnpm build', exitCode: 0, output: toolOutput },
      },
      { type: 'data-command', data: { cmd: 'pnpm build', stream: 'stdout', text: 'x' } },
    ],
  } as unknown as UIMessage;
}

const user = (text: string): UIMessage =>
  ({
    id: `u-${Math.random()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  }) as UIMessage;

describe('pruneForModel', () => {
  it('不超过保留窗口时只剥掉推理，其余引用不变', () => {
    const u = user('a');
    const msgs = [u, assistant('short')];
    const out = pruneForModel(msgs);
    // 没有推理零件的消息必须保持同一引用（避免无谓重渲染/复制）
    expect(out[0]).toBe(u);
    // 推理属 UI-only：无论新旧都不进模型上下文
    const types = (out[1].parts as unknown as Array<Record<string, unknown>>).map(
      (p) => p.type,
    );
    expect(types).not.toContain('reasoning');
    // 推理被剥掉后，消息对象本身是新对象（内容已变）
    expect(out[1]).not.toBe(msgs[1]);
  });

  it('最近 2 条保持原样，更早的才裁剪', () => {
    const msgs = [
      assistant('x'.repeat(9999)),
      user('a'),
      user('b'),
      user('c'),
      user('d'),
    ];
    const out = pruneForModel(msgs);
    expect(out[3]).toBe(msgs[3]); // 窗口内：原样
    expect(out[4]).toBe(msgs[4]);
    expect(out[0]).not.toBe(msgs[0]); // 窗口外：已裁剪（新对象）
    expect(out[1]).toBe(msgs[1]); // 用户消息不含工具零件，内容不变
  });

  it('老轮次的工具【入参】也截断（write_file 的入参是整个文件内容）', () => {
    const big = 'f'.repeat(20000);
    const msgs = [
      {
        id: 'a',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'write_file',
            toolCallId: 'c2',
            state: 'output-available',
            input: { path: 'src/App.tsx', content: big },
            output: { ok: true, path: 'src/App.tsx', bytes: big.length },
          },
        ],
      } as unknown as UIMessage,
      user('a'),
      user('b'),
    ];
    const out = pruneForModel(msgs);
    const part = (out[0].parts as unknown as { input?: { content?: string } }[])[0];
    expect(String(part.input?.content)).toContain('历史入参已截断');
    expect(String(part.input?.content).length).toBeLessThan(1000);
  });

  it('老消息：截断工具输出、丢弃思考与 UI-only 零件，但保留工具调用的配对', () => {
    const long = 'y'.repeat(5000);
    const msgs = [
      user('hi'),
      assistant(long),
      user('a'),
      user('b'),
      user('c'),
      user('d'),
    ];
    const out = pruneForModel(msgs);
    const parts = out[1].parts as unknown as {
      type: string;
      output?: { output?: string };
    }[];
    const types = parts.map((p) => p.type);
    expect(types).toContain('dynamic-tool'); // 工具调用必须留（否则上游报缺少结果）
    expect(types).not.toContain('reasoning'); // 思考过程丢弃
    expect(types).not.toContain('data-command'); // UI-only 丢弃
    expect(parts.find((p) => p.type === 'dynamic-tool')?.output?.output).toContain(
      '已截断',
    );
  });

  it('截断后的长度受控（不再把 237KB 原样发上去）', () => {
    const huge = 'z'.repeat(200_000);
    const msgs = [assistant(huge), user('a'), user('b'), user('c'), user('d')];
    const out = pruneForModel(msgs);
    const size = JSON.stringify(out[0]).length;
    expect(size).toBeLessThan(3000);
  });
});

describe('repairDanglingToolCalls：被中断的悬空工具调用', () => {
  /** 上一轮被中断：助手消息里停在 input-available，没有结果 */
  const dangling = (): UIMessage =>
    ({
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', text: '先把事实核一遍再回答。', state: 'done' },
        {
          type: 'tool-run_command',
          toolCallId: 'call_00_tS4XZDqKnl3710ayWghx2252',
          state: 'input-available',
          input: { cmd: 'ls apps' },
        },
      ],
    }) as unknown as UIMessage;

  it('把没有结果的工具调用改写成 output-error（配对成立）', () => {
    const out = repairDanglingToolCalls([dangling()]);
    const tool = (out[0].parts as unknown as Array<Record<string, unknown>>)[2];
    expect(tool.state).toBe('output-error');
    expect(String(tool.errorText)).toContain('中断');
    expect(tool.input).toEqual({ cmd: 'ls apps' });
    // 文本与步骤零件保持原样
    expect((out[0].parts as unknown as Array<Record<string, unknown>>)[1].text).toBe(
      '先把事实核一遍再回答。',
    );
  });

  it('input 缺失时补空对象（output-error 要求 input 存在）', () => {
    const msg = {
      id: 'a2',
      role: 'assistant',
      parts: [{ type: 'tool-run_command', toolCallId: 'c9', state: 'input-streaming' }],
    } as unknown as UIMessage;
    const tool = (
      repairDanglingToolCalls([msg])[0].parts as unknown as Array<Record<string, unknown>>
    )[0];
    expect(tool.state).toBe('output-error');
    expect(tool.input).toEqual({});
  });

  it('已有结果的工具调用不动（引用不变，避免无谓重渲染）', () => {
    const ok = assistant('built');
    const out = repairDanglingToolCalls([ok]);
    expect(out[0]).toBe(ok);
  });

  it('用户消息不受影响', () => {
    const u = user('继续');
    expect(repairDanglingToolCalls([u])[0]).toBe(u);
  });

  it('修复后能通过 AI SDK 的配对校验（不再 Tool result is missing）', async () => {
    const { convertToModelMessages } = await import('ai');
    const repaired = repairDanglingToolCalls([user('看下目录'), dangling()]);
    const converted = await convertToModelMessages(repaired);
    const toolResult = converted.find((m) => m.role === 'tool');
    expect(toolResult).toBeTruthy();
  });
});

describe('repairInterruptedParts：中断留下的半截零件', () => {
  const interrupted = (): UIMessage =>
    ({
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', id: 'r1', text: '我在想……还没想完', state: 'streaming' },
        { type: 'text', text: '我正在', state: 'streaming' },
        {
          type: 'tool-run_command',
          toolCallId: 'c1',
          state: 'input-available',
          input: { cmd: 'ls' },
        },
      ],
    }) as unknown as UIMessage;

  it('丢弃半截推理（否则模型会续写、把上游流撑断）', () => {
    const out = repairInterruptedParts([interrupted()]);
    const types = (out[0].parts as unknown as Array<Record<string, unknown>>).map(
      (p) => p.type,
    );
    expect(types).not.toContain('reasoning');
  });

  it('半截文本保留内容并标记完成', () => {
    const part = (
      repairInterruptedParts([interrupted()])[0].parts as unknown as Array<
        Record<string, unknown>
      >
    ).find((p) => p.type === 'text');
    expect(part?.text).toBe('我正在');
    expect(part?.state).toBe('done');
  });

  it('已完成的推理不动（引用不变）', () => {
    const done = {
      id: 'a2',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: '想完了', state: 'done' }],
    } as unknown as UIMessage;
    expect(repairInterruptedParts([done])[0]).toBe(done);
  });

  it('pruneForModel 对最近窗口也剥掉推理（故障就在这里漏过去）', () => {
    const msgs = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      interrupted(),
    ] as unknown as UIMessage[];
    const out = pruneForModel(msgs);
    const all = out.flatMap(
      (m) => (m.parts ?? []) as unknown as Array<Record<string, unknown>>,
    );
    expect(all.some((p) => p.type === 'reasoning')).toBe(false);
  });
});

describe('dropEmptyAssistantTurns：只剩推理/step-start 的空助手回合', () => {
  it('丢掉空助手回合，保留用户消息与有内容的助手回合', () => {
    const msgs = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '做个贪吃蛇' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: '歪！' }] },
    ] as unknown as UIMessage[];
    const out = dropEmptyAssistantTurns(msgs);
    expect(out.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('带工具调用的助手回合不算空', () => {
    const withTool = {
      id: 'a2',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'tool-run_command',
          toolCallId: 'c1',
          state: 'output-available',
          input: {},
          output: {},
        },
      ],
    } as unknown as UIMessage;
    expect(dropEmptyAssistantTurns([withTool])).toHaveLength(1);
  });
});
