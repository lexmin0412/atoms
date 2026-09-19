import { tool } from 'ai';
import { z } from 'zod';
import type { Runtime, Workspace } from '@atoms/shared';

const MAX_CMD_OUTPUT = 8000;

export type Emit = (part: unknown) => void;

export function createTools(runtime: Runtime, ws: Workspace, emit?: Emit) {
  return {
    list_files: tool({
      description: '列出项目内所有文件路径（相对项目根目录，已忽略 node_modules/dist 等）。',
      inputSchema: z.object({}),
      execute: async () => ({ files: await runtime.listFiles(ws) }),
    }),

    read_file: tool({
      description: '读取指定文件的完整内容。',
      inputSchema: z.object({
        path: z.string().describe('相对项目根的路径，例如 apps/web/src/App.tsx'),
      }),
      execute: async ({ path }) => ({
        path,
        content: await runtime.readFile(ws, path),
      }),
    }),

    write_file: tool({
      description: '新建或覆盖一个文件。',
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        await runtime.writeFile(ws, path, content);
        return { ok: true, path, bytes: content.length };
      },
    }),

    edit_file: tool({
      description:
        '在文件中把 old_string 精确替换为 new_string。old_string 必须在文件中唯一出现，否则会失败。优先用它做小改动。',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      execute: async ({ path, old_string, new_string }) => {
        await runtime.editFile(ws, path, old_string, new_string);
        return { ok: true, path };
      },
    }),

    run_command: tool({
      description:
        '在项目根目录执行 shell 命令并返回输出。用于 pnpm install / pnpm -r build / 运行校验等。',
      inputSchema: z.object({
        cmd: z.string().describe('要执行的命令，例如 pnpm install'),
      }),
      execute: async ({ cmd }) => {
        let out = '';
        let exitCode = 0;
        for await (const ch of runtime.exec(ws, cmd)) {
          if (ch.data) {
            out += ch.data;
            emit?.({
              type: 'data-command',
              data: { cmd, stream: ch.stream, text: ch.data },
            });
          }
          if (ch.exitCode !== undefined) exitCode = ch.exitCode;
        }
        const truncated = out.length > MAX_CMD_OUTPUT;
        return {
          cmd,
          exitCode,
          output: truncated ? out.slice(-MAX_CMD_OUTPUT) : out,
          ...(truncated ? { note: 'output truncated' } : {}),
        };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof createTools>;
