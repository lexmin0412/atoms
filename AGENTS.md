# AGENTS.md

[原始需求](./demands.md)

Atoms：一个「对话即应用」的 AI Agent 平台。用户用自然语言描述需求，Agent 在**真实隔离沙箱**里写文件、装依赖、构建，右侧实时预览，并可一键发布分享。

> 架构、取舍、里程碑见 [DESIGN.md](./DESIGN.md)；面向人的介绍见 [README.md](./README.md)。

## 架构速览（部署前必读）

**双机、控制面/数据面分离**，不要混：

- **A 机（控制面）**：React SPA + Hono BFF + Postgres。持有 LLM Key、跑 Agent 循环、存源码（**唯一事实源**）。**永不执行生成代码。**
- **B 机（数据面）**：Docker 沙箱。执行不可信代码，**不持有任何密钥**。A 通过 SSH 隧道访问，B 不暴露公网端口。

生成的用户代码一律只进 B；A 上不 `eval`、不跑 `run_command` 的真实产物。

## 目录结构（pnpm workspace monorepo）

```
apps/api/      # A 机 BFF：认证、项目、Agent 循环、Runtime 适配层
apps/web/      # React 工作台（Vite + Tailwind）
apps/sandbox/  # B 机沙箱服务（Docker 编排 + 文件/执行 API）
packages/shared/  # 共享类型（Runtime 接口、DTO）
```

## 常用命令

```bash
pnpm install
cp .env.example .env          # DATABASE_URL / OPENCODE_GO_API_KEY / SANDBOX_* / SESSION_SECRET
pnpm --filter @atoms/api db:init   # 建表（改 schema.sql 后两端都要跑）
pnpm dev                      # 同时起 api(:8787) + web(:5173)
pnpm -r typecheck             # 改完必跑
pnpm --filter @atoms/web build     # 前端构建
```

## 约定与红线

1. **`.env` 绝不提交**（已 gitignore）。LLM Key、DB 密码、`SANDBOX_SHARED_SECRET` 只放各自机器的 `.env`；A/B 的 `SANDBOX_SHARED_SECRET` 必须一致。
2. **Node 用 22.23.1**（A 机：`~/.local/share/fnm/node-versions/v22.23.1/installation/bin`；v22.0.0 不支持 pnpm）。
3. **根 `.npmrc` 的 `dangerously-allow-all-builds=true` 不能删**，否则 esbuild 等依赖的构建脚本被跳过，`vite build` 会挂。
4. **接模型必须带 `x-opencode-session` + 自定义 `User-Agent`**，否则上游报 `MissingSessionID`。细节见技能 `.agents/skills/atoms-opencode-go`。
5. **AI SDK v7**：`convertToModelMessages` 是异步的；工具 `execute` 拿不到 UI writer，流式工具输出要走 `createUIMessageStream` + 闭包。
6. **nginx 反代 `/api` 必须关 SSE buffering**（`proxy_buffering off`），否则流式不可见。
7. 改完代码**至少跑 `pnpm -r typecheck`**；改 UI/逻辑尽量本地起服务自测。

## 部署与运维

**必须用技能 `.agents/skills/atoms-deploy`**（A/B 双机路径、pm2/systemd 进程名、分端部署流程、9 条踩坑、排障顺序都在里面）。涉及 `<A_HOST>` / `<B_HOST>` / `atoms.lexmin.cn` 时先读它。

## 相关文档

- [DESIGN.md](./DESIGN.md)：架构与设计决策、路线图
- [SUBMISSION.md](./SUBMISSION.md)：完成度、已知限制、扩展计划
- 技能：`.agents/skills/atoms-deploy`、`.agents/skills/atoms-opencode-go`、`.agents/skills/git-commit`
