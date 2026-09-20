import type { Runtime, Workspace } from '@atoms/shared';
import { tool } from 'ai';
import { z } from 'zod';

import { forbiddenReason, scrubSecrets } from './redact';
import { skillBody, skillsBrief } from './skills';

const MAX_CMD_OUTPUT = 8000;

export type Emit = (part: unknown) => void;

export interface ToolContext {
  userId: string;
  projectId: string;
}

export function createTools(
  runtime: Runtime,
  ws: Workspace,
  emit?: Emit,
  ctx?: ToolContext,
) {
  return {
    list_files: tool({
      description:
        '列出项目内所有文件路径（相对项目根目录，已忽略 node_modules/dist 等）。',
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
        // 兜底脱敏：万一文件里混入凭据，也不让它进入模型上下文
        content: scrubSecrets(await runtime.readFile(ws, path)),
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
      execute: async ({ cmd }, { abortSignal }) => {
        // 工具层拦截：读取环境/主机信息的侦察命令直接拒绝，不执行
        const why = forbiddenReason(cmd);
        if (why) {
          return {
            cmd,
            refused: true,
            reason: `该命令涉及${why}，出于安全策略被拒绝执行。请专注于完成用户的开发任务。`,
          };
        }

        let out = '';
        let exitCode = 0;
        for await (const ch of runtime.exec(ws, cmd, { signal: abortSignal })) {
          if (ch.data) {
            out += ch.data;
            // 流给前端的终端内容同样脱敏（用户看到的不该是凭据）
            emit?.({
              type: 'data-command',
              data: { cmd, stream: ch.stream, text: scrubSecrets(ch.data) },
            });
          }
          if (ch.exitCode !== undefined) exitCode = ch.exitCode;
        }
        const truncated = out.length > MAX_CMD_OUTPUT;
        const sliced = truncated ? out.slice(-MAX_CMD_OUTPUT) : out;
        return {
          cmd,
          exitCode,
          output: scrubSecrets(sliced),
          ...(truncated ? { note: 'output truncated' } : {}),
        };
      },
    }),

    // ---- 技能：自动命中用（用户显式选中的技能由后端直接注入正文）----
    ...(ctx
      ? {
          list_skills: tool({
            description:
              '列出用户为本项目准备的自定义技能（名字 + 适用场景）。当用户的请求可能与某个技能的适用场景相关时，先调用它看看有没有可用的技能。',
            inputSchema: z.object({}),
            execute: async () => ({
              skills: await skillsBrief(ctx.userId, ctx.projectId),
            }),
          }),

          read_skill: tool({
            description:
              '读取指定技能的完整内容（工作规范 / 操作手册）。当用户明确要求使用某个技能，或 list_skills 里有技能与当前任务明显相关时调用。若技能内容要求使用某个命令行工具，先 `npm i -g <包名>` 装上再执行。',
            inputSchema: z.object({
              name: z.string().describe('技能名称，取自 list_skills 的结果'),
            }),
            execute: async ({ name }) => {
              const hit = await skillBody(ctx.userId, ctx.projectId, name);
              if (!hit) {
                return { found: false, note: `没有找到名为「${name}」的技能` };
              }
              return { found: true, name: hit.name, content: hit.body };
            },
          }),
        }
      : {}),
  };
}

export type AgentTools = ReturnType<typeof createTools>;
