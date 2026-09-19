---
name: atoms-opencode-go
description: >
  Atoms-Demo 里「接模型 + Agent 流式」的约定与坑：OpenCode Go（zen/go）作为 LLM 供应商，
  Vercel AI SDK v7 的工具循环、流式工具输出、消息 parts。
  当需要「接/换模型」「报 MissingSessionID」「AI SDK 升级后 API 变了」「工具输出不流式」
  「实现 agent 循环 / run_command 流式」「改 chat 路由」时使用。
  涉及 createOpenAICompatible、streamText、createUIMessageStream、useChat、convertToModelMessages 时也用本技能。
tags: ["LLM", "AI-SDK", "Atoms"]
---

# Atoms × OpenCode Go × AI SDK v7

## OpenCode Go 接入（最容易踩的坑）

**症状**：报 `MissingSessionID — Request is missing x-opencode-session`，前端只看到通用的 `An error occurred.`。

**原因**：Go 要求客户端自报身份。必须两个头：
1. `x-opencode-session`：**每个会话一个稳定 id**（本项目用 `projectId`），用于路由与 prompt 缓存；
2. `User-Agent`：自定义名（如 `atoms-demo/1.0`），**不能是通用 SDK/HTTP 库名**。

实现（见 `apps/api/src/agent.ts` + `routes/chat.ts`）：provider 级设 UA，逐请求设 session。
```ts
const provider = createOpenAICompatible({
  name: 'opencode-go',
  baseURL: 'https://opencode.ai/zen/go/v1',
  apiKey: config.llm.apiKey,
  headers: { 'User-Agent': 'atoms-demo/1.0' },
});
export const model = provider('deepseek-v4.1-flash');
// streamText({ ..., headers: { 'x-opencode-session': projectId, 'User-Agent': 'atoms-demo/1.0' } })
```

**排查习惯**：前端错误信息被 AI SDK 抹成通用文案，**真实上游报错在服务端日志**（我们打印在 `[chat] stream error:`）。遇到莫名失败先看服务端日志的 `responseBody`。

## 端点与配额

- 模型按兼容协议分流：`/v1/chat/completions`（`@ai-sdk/openai-compatible`，如 deepseek/glm/kimi）、`/v1/responses`（`@ai-sdk/openai`）、`/v1/messages`（`@ai-sdk/anthropic`）。模型清单：`GET /v1/models`。
- 配额查询：`GET /v1/usage` → `{ usage: { rolling, weekly, monthly: { status, percent, resetsAt } } }`。`percent` 是**相对各窗口的整数**，只适合展示。本项目在 `routes/usage.ts` 透出为「系统额度」。
- 这是**共享池**，不是 per-user 计量；per-user 公平性要在 BFF 自己记账（本项目用每用户 24h 消息额度兜底）。

## AI SDK v7 的几个反直觉点

1. **`convertToModelMessages` 是异步的**：`messages: await convertToModelMessages(uiMessages)`。升级后如果报 “missing properties from type ModelMessage[]”，就是忘了 await。
2. **工具 `execute` 拿不到 UI writer**：`writer` 只在 `createUIMessageStream({ execute: ({ writer }) => ... })` 里。要让工具边跑边推流，**用闭包把 writer 传进工具工厂**。
3. **工具定义**：`tool({ description, inputSchema: z.object({...}), execute })`（是 `inputSchema`，不是 parameters）。
4. **异步生成器工具不被流式消费**：不要指望 `execute` 返回 async generator 就能流式，要走上面的 data part。

## 流式工具输出（本项目实现方式）

命令输出（`pnpm install` 等）要实时显示，做法：
```ts
const stream = createUIMessageStream({
  originalMessages: uiMessages,
  execute: async ({ writer }) => {
    const tools = createTools(getRuntime(), ws, (part) => writer.write(part as never));
    const result = streamText({ model, system, messages, tools, stopWhen: stepCountIs(30), maxRetries: 2, headers });
    writer.merge(result.toUIMessageStream());
  },
  onEnd: async ({ messages }) => { /* 持久化完整 parts + 快照源码 */ },
  onError: () => 'An error occurred.',
});
return createUIMessageStreamResponse({ stream });
```
工具里对每段输出 `emit?.({ type: 'data-command', data: { cmd, stream, text } })`。前端按 `type === 'data-command'` 聚合成终端块。

**持久化**：用 `onEnd` 里的完整 `messages` 存 assistant 的 `parts`（含 `tool-*`、`data-*`、`text`），这样历史回放才有工具卡片；多轮把历史全量发回给 `convertToModelMessages` 不会报错。

## 前端（`@ai-sdk/react`）

```ts
const transport = useMemo(() => new DefaultChatTransport({ api: `/api/projects/${id}/chat` }), [id]);
const { messages, sendMessage, status, error, setMessages } = useChat({ transport });
sendMessage({ text });           // 不是 handleSubmit/input 那套 v4 API
// 渲染：message.parts —— 文本 part.type==='text'；工具 part.type==='tool-<name>' 或 'dynamic-tool'
```

## 本地开发小抄

- 开发用 `pnpm dev`（api :8787 + web :5173，vite 代理 `/api`）。
- 换模型只改 `.env` 的 `DEFAULT_MODEL`；默认 `deepseek-v4.1-flash`（便宜、额度足）。
