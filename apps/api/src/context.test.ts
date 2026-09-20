import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { pruneForModel } from './context';

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
  it('消息不超过保留窗口时原样返回（引用都不变）', () => {
    const msgs = [user('a'), assistant('short')];
    expect(pruneForModel(msgs)).toBe(msgs);
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
