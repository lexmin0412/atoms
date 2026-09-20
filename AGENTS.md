# AGENTS.md

[原始需求](./demands.md)

Another Atoms：一个「对话即应用」的 AI Agent 平台。用户用自然语言描述需求，Agent 在**真实隔离沙箱**里写文件、装依赖、构建，右侧实时预览，并可一键发布分享。

> 架构见 [docs/architecture.md](./docs/architecture.md)，路线图见 [docs/roadmap.md](./docs/roadmap.md)；面向人的介绍见 [README.md](./README.md)。

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
pnpm -r typecheck             # 类型检查
pnpm lint                     # oxlint
pnpm fmt                      # oxfmt 格式化
pnpm test                     # vitest
pnpm --filter @atoms/web build     # 前端构建
```

## 约定与红线

1. **`.env` 绝不提交**（已 gitignore）。LLM Key、DB 密码、`SANDBOX_SHARED_SECRET` 只放各自机器的 `.env`；A/B 的 `SANDBOX_SHARED_SECRET` 必须一致。
2. **Node 用 22.23.1**（A 机：`~/.local/share/fnm/node-versions/v22.23.1/installation/bin`；v22.0.0 不支持 pnpm）。
3. **根 `.npmrc` 的 `dangerously-allow-all-builds=true` 不能删**，否则 esbuild 等依赖的构建脚本被跳过，`vite build` 会挂。
4. **接模型必须带 `x-opencode-session` + 自定义 `User-Agent`**，否则上游报 `MissingSessionID`。细节见技能 `.agents/skills/atoms-opencode-go`。
5. **AI SDK v7**：`convertToModelMessages` 是异步的；工具 `execute` 拿不到 UI writer，流式工具输出要走 `createUIMessageStream` + 闭包。
6. **nginx 反代 `/api` 必须关 SSE buffering**（`proxy_buffering off`），否则流式不可见。
7. 改完代码**至少跑 `pnpm -r typecheck` + `pnpm lint`**；动手前后用 `pnpm fmt` 统一格式；改逻辑补/跑 `pnpm test`；改 UI 尽量本地起服务自测。

## 迭代与文档

文档都在 `docs/` 下：

```
docs/
├─ README.md            # 索引、迭代约定与工作流程
├─ architecture.md      # 系统架构（权威来源，持续更新）
├─ roadmap.md           # 路线图与已知限制（滚动更新）
└─ iterations/          # 每次迭代一份方案（append-only，编号递增）
   ├─ 000-template.md
   └─ <NNN>-<主题>.md
```

- **架构 vs 迭代**：`architecture.md` 描述「系统现在长什么样」（长期）；`iterations/` 是「一次迭代一份、不删旧档」的方案与完成情况——改动优先更新架构，历史留在迭代。
- **工作流程（体系化优化 / 整块功能迭代）**：先用 `grill-me` 技能**逐个**澄清需求 → 制定计划 → 用户确认 → 落 `docs/iterations/<NNN>-<主题>.md` → 执行 → 验收通过后回溯更新文档。零散小改动不套此流程。
- 完整约定见 [docs/README.md](./docs/README.md)。

## 部署与运维

**必须用技能 `.agents/skills/atoms-deploy`**（A/B 双机拓扑、pm2/systemd 进程名、分端部署流程、踩坑清单、排障顺序都在里面）。真实主机/密钥/域名见同目录 **gitignored 的 `local.env`**（不在仓库里）。

## 相关文档

- [docs/architecture.md](./docs/architecture.md)：系统架构（权威来源）
- [docs/roadmap.md](./docs/roadmap.md)：路线图与已知限制
- [docs/README.md](./docs/README.md)：文档索引与迭代约定
- 技能：`.agents/skills/atoms-deploy`、`.agents/skills/atoms-opencode-go`、`.agents/skills/git-commit`
