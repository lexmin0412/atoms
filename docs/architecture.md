# 架构

> Atoms-Demo 是一个「对话即应用」的 AI Agent 平台：用自然语言描述需求，Agent 在**真实隔离沙箱**里写文件、装依赖、构建，右侧实时预览，并可一键发布分享。
> 本文档描述**系统当前长什么样**，是架构的权威来源；实现进度与排期见 [roadmap.md](./roadmap.md)，单次改动见 [iterations/](./iterations/)。

## 1. 总体架构：控制面 / 数据面分离

```
┌──────────────── A 机（控制面）────────────────┐
│  nginx(443)                                   │
│   ├─ /            → React SPA（静态构建产物）   │
│   └─ /api/*       → Hono(Node) 127.0.0.1:3010  │
│        ├─ Agent 循环（Vercel AI SDK，持有 LLM Key）
│        ├─ Postgres（源码 / 会话 / 消息 / 用户 / 发布）
│        └─ Runtime 适配层 ──┐                    │
│   /share/<token>/*  → 公开只读分享产物          │
└────────────────────────────┼──────────────────┘
                             │ SSH 隧道（B 不暴露公网端口）+ HMAC
┌────────────────────────────▼──────────────────┐
│  B 机（数据面）                                  │
│   沙箱服务(Node) 127.0.0.1:4000                 │
│    └─ Docker：每项目一个隔离容器（真 FS + shell） │
│  （不持有任何密钥）                              │
└────────────────────────────────────────────────┘
```

**关键原则**
1. **Agent 循环在 A**（LLM Key 只在 A）；工具执行经 A→B 转发到沙箱。
2. **A 是源码唯一事实源（SSOT）**；B 的容器是工作副本，可随时重建。
3. **B 无任何密钥**，与 A 不同信任域——沙箱逃逸也拿不到密钥与数据库。

## 2. 运行时适配层（`Runtime`）

把「文件系统 + 执行」抽象成接口，业务代码（Agent 工具、快照、预览）与运行环境解耦。

```ts
// packages/shared/src/index.ts
export interface Runtime {
  open(projectId: string, files: FileMap): Promise<Workspace>;
  close(ws: Workspace): Promise<void>;
  readFile(ws: Workspace, path: string): Promise<string>;
  writeFile(ws: Workspace, path: string, content: string): Promise<void>;
  editFile(ws: Workspace, path: string, oldStr: string, newStr: string): Promise<void>;
  listFiles(ws: Workspace): Promise<string[]>;
  exec(ws: Workspace, cmd: string): AsyncIterable<ExecChunk>; // 流式 stdout/stderr + exitCode
  snapshot(ws: Workspace): Promise<FileMap>; // 跳过 node_modules/dist 等
  previewUrl(ws: Workspace): Promise<string>;
}
```

- 当前实现：`SandboxRuntime`（`apps/api/src/runtime/sandbox.ts`），对接 B 机沙箱服务。
- 接口保持环境无关，未来可替换（如浏览器内 WebContainer）。

## 3. 沙箱（B 机）

### 3.1 基础镜像
`apps/sandbox/docker/Dockerfile`：基于 `node:22-bookworm-slim`，写入全局 `/usr/local/etc/npmrc`（腾讯内网源 `mirrors.tencentyun.com`、共享 `store-dir=/pnpm-store`、`dangerously-allow-all-builds=true`）并 `npm i -g pnpm@10`。
> 不在镜像里装 apt 包（国内 Debian 源慢）；按需再加。

### 3.2 容器创建参数（每项目）
```bash
docker run -d --name atoms-<id> \
  --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 \
  --cap-drop=ALL --security-opt=no-new-privileges --user <hostUid:hostGid> \
  --network=atoms-sandbox \
  -v /srv/atoms/<id>:/workspace -v /srv/atoms/.pnpm-store:/pnpm-store \
  -w /workspace atoms-sandbox:latest sleep infinity
```

### 3.3 生命周期与自愈
- 打开项目 → 无容器则创建，从 A 的源码写入 `/workspace`。
- 每轮结束 → 源码快照回 A（跳过 `node_modules`/`dist`）。
- **空闲回收**：默认 30 分钟无活动即停容器（保留工作区目录）；下次访问由 `ensureSandbox` 自动重建，**源码不丢**（`node_modules` 需重装，靠共享 store 加速）。
- **并发闸门**：运行中容器数达上限（默认 4）时拒绝创建，返回 429。

### 3.4 A↔B 协议（HTTP + HMAC-SHA256）
```
POST   /sandbox                    创建/确保容器
POST   /sandbox/:id/exec           执行命令（ndjson 流：stdout/stderr/exitCode）
GET    /sandbox/:id/file?path=     读文件
PUT    /sandbox/:id/file           写文件
GET    /sandbox/:id/files          列出文件
POST   /sandbox/:id/snapshot       源码快照
GET    /sandbox/:id/preview[/...]  预览：静态托管 apps/web/dist
GET    /sandbox/:id/preview-version
POST   /sandbox/:id/dist-snapshot  产物快照（发布用）
DELETE /sandbox/:id                销毁（含工作区）
```
- 签名：`HMAC(secret, ts \n method \n pathWithQuery \n sha256(body))`，带时间戳防重放（60s 窗口）。
- `SANDBOX_SHARED_SECRET` 两端一致；B 只接受来自 A 的连接。

## 4. 生成物结构（monorepo）

```
<project>/
├─ package.json            # workspaces
├─ pnpm-workspace.yaml
└─ apps/
   ├─ web/                 # React + Vite（前端，入口 index.html + src/main.tsx）
   └─ api/                 # Hono（后端，按需生成）
```

- 构建：`pnpm -r build` → 前端产出 `apps/web/dist`（静态）。
- Vite 需设置 `base: './'`，使产物可在子路径（预览/分享）下正确加载资源。

## 5. Agent 设计

### 5.1 工具
`read_file` / `write_file` / `edit_file` / `list_files` / `run_command`（真实执行，流式）。
`edit_file` 采用**精确替换**（`applyEdit`，`old_string` 必须存在）。

### 5.2 循环（Vercel AI SDK v7）
- `streamText` + `stopWhen: stepCountIs(30)` + `maxRetries: 2`。
- 每个会话带稳定 `x-opencode-session`（用 projectId）+ 自定义 `User-Agent`，否则上游报 `MissingSessionID`。
- 用 `createUIMessageStream` 包裹，把 writer 通过闭包注入工具 → `run_command` 的输出以自定义 **`data-command`** part 实时流式推给前端。
- `onEnd` 持久化完整 `parts`（含 `reasoning` / `tool-*` / `data-command` / `text`），历史可回放；随后快照源码。

### 5.3 System Prompt 要点
- 产物是 pnpm workspace monorepo（`apps/web` + 可选 `apps/api`）。
- 依赖用 `pnpm add`；**每次改动后必须构建验证**。
- 前端 API 基址读 `import.meta.env.VITE_API_BASE`（便于预览/发布切换）。

## 6. 数据模型（A / Postgres）

```sql
users        (id, email, username, password_hash, created_at)
sessions     (id, user_id, token, expires_at)
projects     (id, user_id, title, status, created_at, updated_at)
files        (project_id, path, content, updated_at)          -- 源码（SSOT）
messages     (id, project_id, seq, role, parts jsonb, created_at)
app_releases (project_id, status, frontend_target, container_ip, container_port, db_schema, error, updated_at)  -- 发布记录
```
**纪律**：DB 只存**源码与文本产物**，绝不存 `node_modules` / `dist` / `.git`。
**已发布应用数据**：每个应用一个独立 schema（`app_<短id>`），与应用源码库表隔离。

## 7. 后端 API（A / Hono）

```
POST   /api/auth/register | login | logout
GET    /api/auth/me
GET    /api/projects                 POST /api/projects
GET    /api/projects/:id             PATCH/DELETE /api/projects/:id
GET    /api/projects/:id/tree | file?path= | messages
POST   /api/projects/:id/chat        发送消息 → SSE（Agent 循环）
GET    /api/projects/:id/preview[/...]          预览（代理沙箱 dist）
GET    /api/projects/:id/preview-version        产物版本（前端轮询刷新）
POST   /api/projects/:id/publish                发布 → 独立应用
GET    /api/projects/:id/deployment             发布状态（前端轮询到 running）
POST   /api/projects/:id/unpublish              下架
GET    /api/usage                    系统额度（上游 /v1/usage）
```
- `/chat` 走 SSE；nginx 必须关 buffering。
- 额度：每用户 24h 消息上限 + 输入长度上限。

## 8. 前端（React）

```
<App>
  <Login/>
  <Projects/>                项目列表（重命名/删除）
  <Chat/>                    工作台
    ├─ 对话区：Markdown(Streamdown，懒加载) / Reasoning(可折叠) / ToolCard / TerminalBlock
    └─ 右侧：预览(iframe) / 文件树 + 源码查看 / 发布分享 / 系统额度
```
- Markdown 用 **Streamdown**（面向流式），代码高亮 Shiki，中文断词 CJK。
- 思考内容 `reasoning` part 渲染为可折叠块（思考中展开、结束折叠）。
- 生成中可「停止」，失败可「重试」。

## 9. 预览与发布

### 预览（开发中）
- `GET /api/projects/:id/preview/` 代理沙箱里 `apps/web/dist`，同源 iframe 展示；前端轮询 `preview-version`，产物变化即刷新。

### 发布（独立应用）
点「发布」→ 得到一个**独立可访问、能真正使用**的线上应用：`https://<projectId>.atoms.lexmin.cn`。

```
发布
 → 校验已构建（apps/web/dist）
 → 前端 dist 上传 COS（<bucket>/apps/<projectId>/，public-read + inline）
 → 若含 apps/api：确保 Postgres schema app_<短id>，在 B 起【常驻发布容器】
        （注入 PORT / HOST=0.0.0.0 / DATABASE_URL(search_path=该 schema)）
 → 写 app_releases
```

**前门（A 机 nginx，`deploy/nginx/atoms-apps.conf`）**
- `server_name "~^(?<app>[0-9a-f-]{36})\.atoms\.lexmin\.cn$"`，泛域名证书
- `/api/*` → 经隧道 → B 沙箱服务 → 该应用常驻容器
- `/` → 回源 COS
- 同源 → 无 CORS

**数据隔离**：每个应用一个 Postgres schema（`app_<短id>`），通过连接串 `search_path` 限定；发布容器用 `RELEASE_DATABASE_URL`（A 机公网地址，因容器在 B）连接。

**生命周期**：重新发布（地址不变，重启容器取最新代码）｜下架（停容器、释放名额）｜常驻**上限 5**。

**证书**：acme.sh + DNSPod DNS-01 签 `atoms.lexmin.cn` + `*.atoms.lexmin.cn`，自动续期（安装在 `/etc/nginx/certs/atoms-wildcard/`）。


## 10. 安全

| 风险 | 措施 |
|---|---|
| 生成代码 RCE | 容器隔离（非 root / cap-drop / no-new-privileges / pids·mem·cpu 限制） |
| 密钥泄露 | B 无任何密钥；Key 只在 A 的 env |
| 越权 | 会话校验；所有项目查询强制带 `user_id` |
| 成本滥用 | 每用户额度 + 输入上限；上游共享额度兜底 |
| 预览同源 | 当前同源 iframe（**已知限制**），生产改独立子域 |

## 11. 部署要点

- **A 机**：nginx 静态 + `/api` 反代（**关 SSE buffering**）；`atoms-api` 与 `atoms-tunnel` 由 pm2 托管。
- **B 机**：沙箱服务由 systemd `atoms-sandbox` 托管（`127.0.0.1:4000`）；A→B 走 SSH 隧道。
- DNS 在 DNSPod；证书用 certbot（单域名 HTTP-01，自动续期）。
- 完整双机路径、进程名与排障顺序见技能 `.agents/skills/atoms-deploy`。
