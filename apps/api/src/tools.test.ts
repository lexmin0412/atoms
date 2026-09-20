import type { ExecChunk, Runtime, Workspace } from '@atoms/shared';
import { describe, expect, it } from 'vitest';

import { createTools } from './tools';

/** 最小 Runtime 打桩：记录 exec 调用，按需吐出输出 */
function stubRuntime(chunks: ExecChunk[]): {
  rt: Runtime;
  execCalls: string[];
} {
  const execCalls: string[] = [];
  const noop = async () => undefined;
  const rt: Runtime = {
    open: async () => ws,
    close: noop,
    readFile: async () => 'ok',
    writeFile: noop,
    deleteFile: noop,
    editFile: noop,
    listFiles: async () => [],
    snapshot: async () => ({}),
    previewUrl: async () => '',
    async *exec(_ws: Workspace, cmd: string) {
      execCalls.push(cmd);
      for (const c of chunks) yield c;
    },
  };
  return { rt, execCalls };
}

const ws: Workspace = { id: 'w', projectId: 'p' };

describe('run_command 工具层防护', () => {
  it('拒绝执行侦察类命令，且不真正调用 exec', async () => {
    const { rt, execCalls } = stubRuntime([]);
    const tools = createTools(rt, ws);
    const res = (await tools.run_command.execute!({ cmd: 'printenv' }, {} as never)) as {
      refused?: boolean;
      reason?: string;
    };
    expect(res.refused).toBe(true);
    expect(res.reason).toContain('拒绝');
    expect(execCalls).toEqual([]);
  });

  it('正常命令照常执行', async () => {
    const { rt, execCalls } = stubRuntime([
      { stream: 'stdout', data: 'ok\n' },
      { stream: 'stdout', data: '', exitCode: 0 },
    ]);
    const tools = createTools(rt, ws);
    const res = (await tools.run_command.execute!(
      { cmd: 'pnpm -r build' },
      {} as never,
    )) as {
      output?: string;
    };
    expect(res.output).toContain('ok');
    expect(execCalls).toEqual(['pnpm -r build']);
  });

  it('命令输出中的连接串会被脱敏后才回给模型', async () => {
    const { rt } = stubRuntime([
      { stream: 'stdout', data: 'DATABASE_URL=postgres://u:p4ssw0rd@h:5432/db\n' },
      { stream: 'stdout', data: '', exitCode: 0 },
    ]);
    const tools = createTools(rt, ws);
    const res = (await tools.run_command.execute!({ cmd: 'cat .env' }, {} as never)) as {
      output?: string;
    };
    expect(res.output).not.toContain('p4ssw0rd');
    expect(res.output).toContain('[redacted:db-url]');
  });

  it('流给前端的终端输出同样脱敏', async () => {
    const { rt } = stubRuntime([
      { stream: 'stdout', data: 'SECRET_KEY=abcdef123456\n' },
      { stream: 'stdout', data: '', exitCode: 0 },
    ]);
    const parts: unknown[] = [];
    const tools = createTools(rt, ws, (p) => parts.push(p));
    await tools.run_command.execute!({ cmd: 'cat .env' }, {} as never);
    const joined = JSON.stringify(parts);
    expect(joined).not.toContain('abcdef123456');
    expect(joined).toContain('[redacted]');
  });
});
