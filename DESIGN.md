# 设计文档：架构与路线图

> Atoms-Demo 是一个「对话即应用」的 AI Agent 平台：用自然语言描述需求，Agent 在**真实隔离沙箱**里写文件、装依赖、构建，右侧实时预览，并可一键发布分享。
> 定位：通用（不限垂直场景），产物为可运行的全栈 monorepo。
> 部署：**A 机（控制面，平台）** + **B 机（数据面，沙箱/构建/运行）** 双机分离。

---

## 0. 范围与决策

| 项 | 决策 |
|---|---|
| 产品方向 | 通用：NL → 生成应用 → 实时预览 → 迭代 → 发布 |
| 产物形态 | **monorepo**：`apps/web`（React+Vite）+ `apps/api`（Hono，可选），真实 `pnpm install` / build / run |
| 认证 | 简单登录（已实现），后续可加 GitHub OAuth |
| 亮点 | ① 一键发布分享链接 ② 文件树 + 源码查看 ③ 系统额度展示（用量可感） |
| 发布承载 | 前端构建产物托管 + 公开只读分享链接；后端 Hono 跑在沙箱 |
| 预览/发布 URL | 子域名形式（生产建议 `*.atoms.lexmin.cn`，泛域名证书） |
| 模型 | 默认 `deepseek-v4.1-flash`（OpenCode Go），共享额度兜底 |
| 范围外 | 多 Agent 编排、多人协作、真实计费、工作流编排 |

> **范围说明**：真实 install/build/run + 沙箱 + 全栈是一套完整的数据面工程。本文档给出完整设计，并标注了实现优先级（§12 路线图）——先打通核心闭环，再逐步补齐亮点。

---

## 1. 总体架构

```
┌───────────────────────── A 机（2C2G，平台/控制面）─────────────────────────┐
│  nginx(443)                                                                 │
│   ├─ /                → React SPA（静态）                                    │
│   └─ /api/*           → Hono(Node) :3000                                    │
│                          ├─ Agent 循环（AI SDK，持有 OpenCode Go key）        │
│                          ├─ 读写 Postgres（源码 / 会话 / 消息 / 用户）          │
│                          └─ Runtime 适配层 ──HTTP(HMAC)──┐                    │
└─────────────────────────────────────────────────────────┼────────────────────┘
                                                          ▼
┌───────────────────────── B 机（2C4G，沙箱/数据面）──────────────────────────┐
│  沙箱服务(Node) :4000  ← 创建/销毁/exec(流式)/快照                           │
│   ├─ Docker: 每会话一个容器（真 FS + shell + pnpm + node）                    │
│   └─ 反代(nginx/Caddy) :443                                               │
│        ├─ *.preview.atoms.lexmin.cn  → 沙箱容器的 Vite/Hono 端口             │
│        └─ *-api.atoms.lexmin.cn      → 已发布应用的 Hono 容器               │
│  （B 机不持有任何密钥）                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

**关键原则**
1. **Agent 循环在 A**（key 只在 A），工具执行通过 A→B 的 HTTP 转发到沙箱。
2. **A 永远是源码的唯一事实源（SSOT）**；B 的容器是工作副本，可随时重建。
3. **B 不放任何密钥**，且和 A 不同安全组，打不通 A 的 Postgres/内网。

---

## 2. 运行时适配层（核心抽象）

```ts
// runtime/types.ts
export type FileMap = Record<string, string>; // path -> content

export interface Runtime {
  open(projectId: string, files: FileMap): Promise<Workspace>;
  close(ws: Workspace): Promise<void>;

  // 文件
  readFile(ws: Workspace, path: string): Promise<string>;
  writeFile(ws: Workspace, path: string, content: string): Promise<void>;
  editFile(ws: Workspace, path: string, oldStr: string, newStr: string): Promise<void>;
  listFiles(ws: Workspace): Promise<string[]>;

  // 真实执行（Design 2 独有）
  exec(ws: Workspace, cmd: string): AsyncIterable<{ stream: 'stdout'|'stderr'; data: string }>;

  // 源码快照（跳过 node_modules / dist / .cache / .git）
  snapshot(ws: Workspace): Promise<FileMap>;

  // 预览/发布
  previewUrl(ws: Workspace): Promise<string>;
}
```

- 实现：`SandboxRuntime`（对接 B 机沙箱服务）。
- 保留一个 `VirtualRuntime`（内存实现）用于**本地开发/离线**，业务代码不变。

---

## 3. 沙箱（B 机）

### 3.1 基础镜像
`Dockerfile.sandbox`（基于 `node:22-bookworm-slim`）：预装 `pnpm`(corepack)、`git`、`curl`，并**预热 pnpm store**（挂载卷复用，避免每次重下）。

### 3.2 容器创建参数（每会话）
```bash
docker run -d \
  --name atoms-<sessionId> \
  --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --user 1000:1000 \
  -v /srv/atoms/<sessionId>:/workspace \
  --network=<sandbox-net> \
  atoms-sandbox:latest sleep infinity
```
- `--read-only` + `--tmpfs` 可选（若影响 install，则挂载可写卷）。
- 网络：默认接一个**受限网络**；install 只放行 **npm 内网源 `mirrors.tencentyun.com`**（可用代理/防火墙实现）。

### 3.3 生命周期
```
打开项目/开始生成
  → 无活跃容器则创建，从 A 拉源码到 /workspace
  → Agent 循环（在 A）通过 exec 在容器内 install/dev/build
  → 每轮结束把源码快照回 A（跳过 node_modules/dist）
空闲 N 分钟 / 会话结束
  → 快照 + 销毁容器（node_modules 丢弃，靠 warm pnpm store 复用）
```

### 3.4 并发闸门
- **按内存计**：每会话预留 ~1G，2C4G 最多 **1-2 并发**；超出则排队并给前端「排队中」。
- Docker 日志上限已配（10m×3）。

### 3.5 A↔B 协议（HTTP + HMAC）
```
POST   /sandbox            创建（返回 id、previewUrl）
POST   /sandbox/:id/exec      流式 stdout/stderr (SSE)
GET    /sandbox/:id/file?path=
PUT    /sandbox/:id/file
DELETE /sandbox/:id        销毁
POST   /sandbox/:id/snapshot  返回源码 FileMap（B 不持久化，A 存）
```
- 双向鉴权：HMAC-SHA256 签名 + 时间戳防重放。
- B 不接受任何来自公网的写操作（安全组只放 A 机 IP）。

---

## 4. 生成物结构（monorepo）

```
<project>/
├─ package.json            # 根：workspaces
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ web/                 # React + Vite（前端）
│  │  ├─ package.json
│  │  ├─ index.html
│  │  └─ src/**
│  └─ api/                 # Hono（后端，按需生成）
│     ├─ package.json
│     └─ src/index.ts
└─ README.md
```

- **构建**：`pnpm -r build`；前端产出 `apps/web/dist`（静态）。
- **运行（预览）**：`pnpm --filter web dev`（Vite）+ `pnpm --filter api dev`（Hono），端口分别由 B 反代暴露。
- **发布**：`apps/web/dist` → COS；`apps/api` → 常驻容器。

> 约束：同一会话的项目**必须在一个目录**，用 workspace 结构，便于扩展与统一构建。

---

## 5. Agent 设计

### 5.1 工具
```ts
list_files()
read_file({ path })
write_file({ path, content })
edit_file({ path, old_string, new_string })
run_command({ cmd })        // ← Design 2 核心，真实执行（流式）
```
- `run_command` 的 `execute` 调用 `runtime.exec()`，把 stdout/stderr 流式回传。

### 5.2 循环
- **Vercel AI SDK** `streamText` + `stopWhen: stepCountIs(25)`（真实开发步数更多）。
- `toUIMessageStreamResponse()` → SSE；前端 `useChat` 直接拿 `message.parts`。
- 模型：`@ai-sdk/openai-compatible` → `https://opencode.ai/zen/go/v1`，默认 `deepseek-v4.1-flash`。

### 5.3 System Prompt 要点
- 产物是 **pnpm workspace monorepo**：前端 `apps/web`（React+Vite），后端 `apps/api`（Hono），按需生成后端。
- 依赖用 `pnpm add`；**每次改动后必须 `pnpm -r build`（或至少 typecheck）验证通过**。
- 前端 API 通过 `import.meta.env.VITE_API_BASE` 读取后端地址（便于预览/发布切换）。
- 不生成多余文件；保持项目可直接 `pnpm -r build` 通过。

### 5.4 diff 展示
- 文件类工具 `execute` 内用 `jsdiff` 对比新旧内容，返回 `{additions, deletions, patch}`。
- `run_command` 展示命令 + 实时输出（终端样式）。

---

## 6. 数据模型（A / Postgres）

```sql
users        (id, email, username, password_hash, created_at)
sessions     (id, user_id, token, expires_at)
projects     (id, user_id, title, entry_dir, status, created_at, updated_at)
files        (project_id, path, content, updated_at, pk(project_id,path))
messages     (id, project_id, seq, role, parts jsonb, created_at)
versions     (id, project_id, seq, files jsonb, message_id, created_at)   -- 可选
deployments  (id, project_id, kind, url, status, container_id, created_at) -- 发布记录
```
**纪律**：DB 只存**源码**，绝不存 `node_modules` / `dist` / `.git`。

---

## 7. 后端 API（A / Hono）

```
POST   /api/auth/register            注册
POST   /api/auth/login               登录（cookie session）
POST   /api/projects                 创建项目
GET    /api/projects                 列表
GET    /api/projects/:id             详情（文件树 + 状态）
GET    /api/projects/:id/files/*     读文件
GET    /api/projects/:id/messages    历史消息
POST   /api/projects/:id/chat        发送消息 → SSE（Agent 循环）
GET    /api/projects/:id/preview     获取预览 URL
POST   /api/projects/:id/publish     发布（前端→COS，后端→常驻容器）
GET    /api/usage                    系统额度（上游 /v1/usage，展示用）
```
- `/chat` 必须走 SSE；nginx 关 buffering（见 §11）。
- 每次写文件 **write-through 到 `files`**。

---

## 8. 前端（React）

```
<App>
  <Auth/>
  <ProjectList/>
  <Workspace>
    <ChatPanel>                 // useChat；TextPart / ToolCard / CommandOutput
    <SidePanel>
      <FileTree/>               // 文件树（亮点②）
      <CodeView/>               // 源码查看（亮点②）
    </SidePanel>
    <PreviewPane>               // iframe 预览沙箱 URL
    <QuotaBadge/>               // 系统额度展示（亮点③）
    <PublishButton/>            // 一键发布分享（亮点①）
  </Workspace>
</App>
```
- 预览用 **iframe 指向沙箱子域名**（跨源隔离，天然拿不到 A 的 cookie）。
- 工具卡片实时更新；`run_command` 输出走终端样式流式渲染。
- 组件库：Tailwind + shadcn。

---

## 9. 发布与 URL 规划

### 9.1 域名与解析（DNS = DNSPod / 腾讯云）
| 用途 | 域名 | 指向 |
|---|---|---|
| 平台 | `atoms.lexmin.cn` | A 机（nginx） |
| 开发预览 | `dev-<sessionId>.atoms.lexmin.cn` | B 机（沙箱） |
| 已发布应用 | `<projectId>.atoms.lexmin.cn` | 前端 → COS；`/api` → B 机容器 |

- DNS 托管在 **DNSPod**（不是 Cloudflare）。
- 需要一条泛解析：`*.atoms.lexmin.cn` → **B 机公网 IP**（A 记录）。
- 已发布应用**同源**：`/api/*` 走后端、其余走 COS 前端 → **无 CORS**，前端用相对路径 `/api` 即可。

### 9.2 前门（路径分流，nginx on B）
`*.atoms.lexmin.cn` 统一由 **B 机 nginx** 承接：
- `dev-<id>.atoms.lexmin.cn` → 对应沙箱容器的 Vite/Hono 端口
- `<id>.atoms.lexmin.cn`：`/api/*` → 对应后端容器；其余 → **COS 桶**（回源/自定义域名）
- 动态 upstream 由沙箱服务生成/更新 nginx 配置并 `reload`

### 9.3 证书（certbot + DNSPod DNS-01）
- 签一张 SAN 泛域名证书：`atoms.lexmin.cn` + `*.atoms.lexmin.cn`（**一张覆盖全部**）。
- 用 certbot 的 **DNSPod API** 走 **DNS-01** 自动签发 + 自动续期。
- ⚠️ `*.atoms.lexmin.cn` **不含 apex** `atoms.lexmin.cn`，需一并签入同一张证书。

### 9.4 发布流程
```
点击发布
  → B 沙箱内 pnpm -r build
  → apps/web/dist 上传 COS 桶（绑定自定义域名）
  → apps/api 以常驻容器运行，经前门以 /api 暴露
  → 分享链接 = https://<projectId>.atoms.lexmin.cn
  → 写入 deployments 表
```

---

## 10. 安全

| 风险 | 措施 |
|---|---|
| 生成代码 RCE | 容器隔离（非 root/cap-drop/no-new-privileges/pids/mem/cpu 限制）；gVisor 可选 |
| 网络滥用 | 容器默认受限网络，install 只放行 npm 内网源 |
| 密钥泄露 | B 无任何密钥；key 只在 A env |
| 越权访问 | 用户会话校验；预览/发布 URL 带随机 id，发布可加访问控制 |
| 预览 XSS | 预览在**独立子域**（跨源），拿不到 A 的 cookie |
| 成本滥用 | 每用户额度中间件（预留→结算）+ 输入长度/max_tokens 上限；上游额度仅兜底 |
| 上游限流 | 捕获 rate-limited 降级提示 |

---

## 11. 部署

### A 机（2C2G，现有生产机）
- Postgres 新建独立库 + 用户，`127.0.0.1:9688`（已在 pg_hba 白名单）。
- Node 用 **v22.23.1**（当前 PATH 的 v22.0.0 不支持 pnpm）。
- pm2 守护；nginx 新站点 `atoms.lexmin.cn`。
- **SSE 必配**：
```nginx
location /api/ {
  proxy_pass http://127.0.0.1:3010;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 600s;
  add_header X-Accel-Buffering no;
}
```

### B 机（数据面，沙箱）
- 沙箱服务：systemd `atoms-sandbox`，监听 `127.0.0.1:4000`；容器镜像 `atoms-sandbox:latest`；共享 pnpm store。
- A→B 通过 SSH 隧道访问（B 不暴露公网端口），HMAC 鉴权。
- 详细部署与排障见技能 `.agents/skills/atoms-deploy`。

---

## 12. 路线图

> 每个里程碑都必须**可验证**（有明确通过标准），跑不通不进入下一个。

| 里程碑 | 目标 | 通过标准 | 状态 |
|---|---|---|---|
| M1 | 控制面骨架 | 注册/登录、建项目、发消息流式返回 | 已完成 |
| M2 | 沙箱服务 | 创建容器、`exec` 流式输出、销毁 | 已完成 |
| M3 | Agent 工具闭环 | 沙箱内写文件 + `pnpm install` + `pnpm -r build`，源码快照回 A | 已完成 |
| M4 | 工作台 | 聊天 + 工具卡片 + 文件树/源码 | 已完成 |
| M5 | 实时预览 | 构建产物变化即自动刷新预览 | 已完成 |
| M6 | 一键发布分享 | 产物快照为公开只读链接 | 已完成 |
| M7 | 额度与打磨 | 系统额度展示 + 体验收尾 | 已完成 |
| M8 | 全栈预览/发布 | 生成的后端可运行并经预览透出 | 待做 |
| M9 | 独立子域预览 | `*.atoms.lexmin.cn` 隔离预览 | 待做 |
| M10 | 沙箱出网白名单 / gVisor | 容器仅能访问 npm 源 | 待做 |

**实现优先级（由核心向外收敛）**：
1. 先保核心闭环（M1–M3）与真实预览（M5）
2. 再加亮点（M4 / M6 / M7）
3. 最后做安全与全栈深化（M8–M10）

---

## 13. 部署与决策
- 平台域名 `atoms.lexmin.cn`（A 机）；预览与发布由 B 机承接。
- DNS 在 DNSPod；证书用 certbot（单域名 HTTP-01，自动续期）。
- A/B 详细部署、进程名与排障顺序见技能 `.agents/skills/atoms-deploy`。
