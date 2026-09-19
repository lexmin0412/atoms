# Atoms-Demo

一个「对话即应用」的 AI Agent 平台原型：用自然语言描述需求，Agent 在**真实沙箱**里写代码、装依赖、构建，右侧**实时预览**可运行的应用，并支持**一键发布分享**。

> 在线 Demo：https://atoms.lexmin.cn

## 核心能力

- **对话式生成**：Agent 通过文件工具 + `run_command` 在沙箱中迭代开发
- **真实执行**：`pnpm install` / `pnpm -r build` 都在隔离容器里真跑（非模拟）
- **实时预览**：构建产物变化即自动刷新 iframe
- **工作台**：对话 / 工具卡片 / 命令终端 / 文件树 / 源码查看
- **一键发布**：把构建产物快照为公开只读链接（`/share/<token>/`）
- **系统额度**：展示上游模型配额，运营者可感知成本

## 架构：控制面 / 数据面分离

```
A 机（控制面，2C2G）                     B 机（数据面，2C4G）
├─ React SPA（nginx 静态）               ├─ 沙箱服务（Hono :4000）
├─ Hono BFF（:3010）                     │   └─ Docker：每项目一个隔离容器
│   ├─ Agent 循环（Vercel AI SDK）        │        （非 root / cap-drop / 资源限制）
│   ├─ 持有 LLM Key                      └─ 静态产物托管 + 预览
│   ├─ Postgres（源码唯一事实源）
│   └─ Runtime 适配层 ── SSH 隧道 ────────────────┘
```

**关键约束**：A 机**永不执行生成代码**；B 机**不持有任何密钥**；两者不在同一信任域，沙箱逃逸也拿不到密钥与数据库。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19 + Vite + TypeScript + Tailwind v4 + AI SDK（`@ai-sdk/react`） |
| 后端 | Hono + Node 22 + Postgres + Vercel AI SDK v7 |
| 模型 | OpenCode Go（`@ai-sdk/openai-compatible`，默认 `deepseek-v4.1-flash`） |
| 沙箱 | Docker（`node:22-bookworm-slim` + pnpm）+ HMAC 鉴权 + SSH 隧道 |
| 部署 | nginx + pm2 + Let's Encrypt |

## 目录结构

```
apps/
  api/       # A 机 BFF：认证、项目、Agent 循环、Runtime 适配层
  web/       # React 工作台
  sandbox/   # B 机沙箱服务（Docker 编排 + 文件/执行 API）
packages/
  shared/    # 共享类型（Runtime 接口、DTO）
```

## 本地开发

```bash
pnpm install
cp .env.example .env      # 填 DATABASE_URL / OPENCODE_GO_API_KEY / SANDBOX_*
pnpm --filter @atoms/api db:init
pnpm dev                  # 同时起 api(:8787) 和 web(:5173)
```

## 部署

- A 机：`pnpm --filter @atoms/web build` → nginx 静态；api 用 pm2 托管；nginx `/api` 反代并**关闭 SSE buffering**。
- B 机：构建沙箱镜像 → systemd 托管沙箱服务 → A 机通过 SSH 隧道访问（B 不暴露公网端口）。

## 已知限制

- **生成物**：默认前端静态应用；全栈（含 Hono 后端）的**预览**尚未端到端打通（见设计文档）。
- **预览隔离**：当前同源 iframe；生产应改为 `*.atoms.lexmin.cn` 独立子域。
- **沙箱出网**：容器当前可访问外网（仅用于装包），生产应收紧为白名单。
- **计费**：未接真实计费，仅做每用户消息额度 + 上游配额兜底。

## 相关文档

- [docs/architecture.md](./docs/architecture.md)：系统架构
- [docs/roadmap.md](./docs/roadmap.md)：路线图与已知限制
- [docs/](./docs/README.md)：文档索引与迭代方案（`docs/iterations/`）
- [AGENTS.md](./AGENTS.md)：面向 AI/协作者的开发约定

## License

[MIT](./LICENSE)
