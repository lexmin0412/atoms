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
- **并发闸门 + 按需回收**：运行中容器数达上限（默认 4，按 2C4G/每容器 1G 计）时，
  先**回收最久空闲的那个**（`stopSandbox` 只删容器、**保留工作区**，A 下次打开会重新同步，源码不丢），
  仍腾不出位置才返回 429，并给可操作文案（不是「模型服务不可用」）。
  60s 内活跃过的沙箱不参与回收；长命令执行期间持续 `touch`，避免「正在装依赖」被判空闲。
- **「停止」是真停止**：生成循环接 `abortSignal`（来自请求），客户端断开即停止模型调用与工具执行，
  长命令（install/build）也会随之中止；已完成的步仍按实际用量结算。
  否则服务端会继续烧 token 并持续占用沙箱（曾把并发池占满，导致后续消息全部 429）。

### 3.4 A↔B 协议（HTTP + HMAC-SHA256）
```
POST   /sandbox                    创建/确保容器
POST   /sandbox/:id/exec           执行命令（ndjson 流：stdout/stderr/exitCode）
GET    /sandbox/:id/file?path=     读文件
PUT    /sandbox/:id/file           写文件
DELETE /sandbox/:id/file?path=     删除文件/目录（递归）
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
-- 平台库（atoms）
users        (id, email, username, password_hash, created_at)
sessions     (id, user_id, token, expires_at)
projects     (id, user_id, title, status, created_at, updated_at)
files        -- 见下方「文件树」
messages     (id, project_id, seq, role, parts jsonb, created_at)
app_releases (project_id, status, frontend_target, container_ip, container_port, db_schema, error, updated_at)
credit_accounts (user_id, balance numeric(14,4), granted_period)      -- 积分账户
credit_ledger   (id, user_id, delta, balance_after, reason, project_id, ref, meta, created_at)
-- messages 增加 credits numeric(14,4)  -- 该条 assistant 消息消耗
```
**纪律**：平台库只存平台数据与**源码**，绝不存 `node_modules` / `dist` / `.git`。

### 文件树（迭代 004）
`files` 是**树形结构**（目录与文件都是节点），而非扁平路径：

```sql
files (id, project_id, pid, name, type['file'|'dir'], path, content, version, updated_at)
-- unique(project_id, path)；pid 指向父目录节点
```

- 目录节点有 `pid` / `path`，无 `content`；文件节点有 `content`。
- **冗余 `path`**：与 Agent 工具、沙箱真实文件系统的「路径」接口衔接；树形 UI 与递归操作（重命名/删除目录）用 `pid`。
- **`version`**：手动编辑的乐观锁；保存时版本不符返回 409（生成中禁止编辑，双重兜底）。
- **与沙箱的一致性**：DB 是唯一事实源。手动编辑 → 落库后增量同步沙箱；同步失败则丢弃工作区缓存，下次从 DB 全量重建（`open` 会先清掉沙箱里多出的文件）。

### Credits（按用户计量与限制，迭代 005）

- **口径**：按 token。取 `streamText` 的 `result.usage`（v7 中即多步**累计**之和；`totalUsage` 是废弃别名），在流结束后结算。
- **计价**：锚定 USD，费率从 [models.dev](https://models.dev/api.json) 拉取（`opencode-go/<DEFAULT_MODEL>` 的 `cost.input/output/cache_read/cache_write`，USD / 1M tokens）。
  **1 积分 = $0.01（100 积分 = $1）**；`credits = (in·r_in + out·r_out + cacheRead·r_cr + cacheWrite·r_cw)/1e6 / 0.01`。
  费率有内存 + 磁盘缓存（TTL 24h），拉取失败回退内置兜底费率，**不阻塞聊天**。
- **发放**：自然月补满到 `CREDITS_MONTHLY_GRANT`（默认 500），以 `granted_period` 保证幂等。
- **限制**：发起前余额 ≤ 0 → **402 `insufficient_credits`**；生成中通过 `stopWhen` 附加条件累计用量，达到起始余额即**优雅停止循环**（不硬杀），并随 `data-credits` part 告知前端「额度用尽，已中断」。
- **结算**：按实际用量扣减（允许扣成负），写 `usage` 流水 + 回写 `messages.credits`；`onEnd`/`onError` 用一次性 promise 防重复扣。
- **并发**：账户行 `select ... for update`，避免并发把余额扣穿。
- **精度**：内部 `numeric(14,4)`，展示 2 位。
- **展示**：顶栏 `CreditsBadge`（余额 / 月额度）、assistant 消息尾部「本次消耗 X.XX 积分」、`/credits` 明细页（余额 + 流水 + 按项目筛选 + 分页）。
- **与上游共享额度的关系**：上游（OpenCode Go）的 5h/周/月 配额是**硬天花板**，credits 是它之上的**按用户公平层**，二者叠加。
- **运维**：不提供公网管理入口。手动调额与系统额度查看走 A 机本地 CLI：
  `pnpm --filter @atoms/api credits grant --email <email> --amount <n> --note <备注>`、`credits list --email <email>`、`credits usage`。

### 安全基线（迭代 007）

| 面 | 措施 |
|---|---|
| **数据隔离** | 每项目独立 DB 角色（见上），容器凭据无跨租户能力 |
| **提示词/宿主信息** | 提示词硬约束 + 工具层拦截侦察命令 + 工具输出脱敏（`redact.ts`） |
| **不可信内容** | 用户产物只走独立子域（`dev-<id>` / `<id>`）；平台域不再代理用户 dist；`/icon` 加 nosniff + CSP sandbox + attachment |
| **认证** | 登录/注册按 IP+账号限流（指数退避）；密码 ≥10 位 + 弱口令黑名单；会话 7 天、登出吊销；显式 Origin 校验 |
| **主机** | A：SSH 仅密钥、ufw 白名单、Postgres 端口仅 B 机与办公网段可达；B：沙箱容器出网白名单（DNS/80/443 + A 的 DB 端口） |
| **响应头** | 平台页 `X-Frame-Options` / `nosniff` / `Referrer-Policy` / `Permissions-Policy` / CSP |

### 数据库迁移（强约束）
**任何 schema 变更都必须带迁移，且能处理线上已有数据。**
`apps/api/src/migrations/<NNNN>-<name>.sql`，序号递增、只增不改、幂等；`schema_migrations` 记录已执行项；`db:init` 负责执行。
破坏性变更（如 `0001-files-tree` 把扁平路径拆成树）必须自带数据搬迁，不得只改 DDL。

### 平台库 / 应用库分离
用户项目的业务数据在**独立的应用库**（`atoms_apps`），与平台库物理隔离：

| 库 | 内容 | 谁连 |
|---|---|---|
| 平台库（`atoms`） | users / sessions / projects / files / messages / app_releases | 平台连接池 |
| 应用库（`atoms_apps`） | 各用户项目的业务 schema | 应用池（开发沙箱 / 发布容器）、只读池 |

**schema 命名**：`p{projectId}_{dev|prod}`（完整 projectId → 零碰撞；长度 ~41，低于 63 字节上限）

**每项目独立数据库角色**（安全边界，迭代 007）：每个 schema 配一个登录角色 `r_p{projectId}_{dev|prod}`，
凭据存平台库 `project_db_roles`。角色被授予本 schema 的 `usage/create`，并 `revoke usage on schema public`。
`databaseUrlFor()` 用该角色拼连接串 —— 容器（开发沙箱 / devapp / 发布容器）即使读到 `DATABASE_URL`，
也**只能访问自己项目的 schema**。前置：管理角色需 `CREATEROLE`。

- **schema 内的对象归项目角色所有**（`alter table/sequence ... owner to`）：生成的 app 启动时通常自己跑迁移
  （`create table if not exists` + `alter table add column` / `create index`），而 `alter` 系列**需要表的所有权** ——
  只授增删改查会报 `must be owner of table`（线上真实事故）。schema 本身仍归管理角色，所以项目角色删不掉 schema、也越不了界。
- 转移所有权需要能 `SET ROLE` 到目标角色：provisioning 会显式 `grant <role> to <admin> with set true`
  （PG16 的历史成员关系默认不含 SET 权限）。
- `atoms_ro` 的读权限由**项目角色自己**的短连接授出（只有 owner 能授权），不走 `SET ROLE`。
- `alter default privileges` 覆盖后续新建的表/序列。
- `_dev`：开发沙箱（Agent 边写边跑，可随意折腾）
- `_prod`：发布容器（数据受保护；发布时从空开始）
- 数据库查看器分「开发 / 生产」，**仅当该 schema 有业务表时才显示入口**

**只读角色** `atoms_ro`：仅能读应用库中的项目 schema（`p*_dev` / `p*_prod`），无法访问平台库。

## 7. 后端 API（A / Hono）

```
POST   /api/auth/register | login | logout
GET    /api/auth/me
GET    /api/projects                 POST /api/projects
GET    /api/projects/:id             PATCH/DELETE /api/projects/:id
GET    /api/projects/:id/tree | file?path= | messages
POST   /api/projects/:id/fs/file | fs/dir           新建文件 / 目录（空目录可建）
PUT    /api/projects/:id/fs/file/:nodeId            保存（乐观锁，409 表示被改动）
PUT    /api/projects/:id/fs/node/:nodeId/rename     重命名/移动（目录递归）
DELETE /api/projects/:id/fs/node/:nodeId            删除（目录递归）
POST   /api/projects/:id/rebuild                    前端构建 + 重启开发预览后端
POST   /api/projects/:id/chat        发送消息 → SSE（Agent 循环）
GET    /api/projects/:id/preview[/...]          预览（代理沙箱 dist）
GET    /api/projects/:id/preview-version        产物版本（前端轮询刷新）
POST   /api/projects/:id/publish                发布 → 独立应用
GET    /api/projects/:id/deployment             发布状态（前端轮询到 running）
POST   /api/projects/:id/unpublish              下架
GET    /api/credits                  余额 + 本周期用量（顺带触发周期发放）
GET    /api/credits/ledger           消耗明细（分页，可按项目筛选）
GET/POST /api/skills                 技能列表（用户级 + 项目级）/ 新建
PUT/DELETE /api/skills/:id           改 / 删
```

**Skills（迭代 008）**：用户把规范/playbook 写成技能，Agent 按需参考。
- **内置技能**：随代码发行（`apps/api/src/skills/builtin/*.md`），所有用户默认可见、不可修改/删除，
  且在列表与 System Prompt 的「可用技能」清单里**始终排最前**；名字被保留（用户不得重名）。
  对外 id 为 `builtin:<key>`。当前内置：`frontend-design`。
- 归属两级：`project_id` 为 null = 用户级（跨项目），否则项目级；每用户自定义上限 20 个（内置不占额度）。
- 唤起两条路：聊天输入框 `/` 显式选择（本轮生效），或 Agent 用 `list_skills` / `read_skill` 自动命中。
- 注入：**显式选中的正文作为「参考资料」附在本轮用户消息上**（不是系统指令，降低正文改行为的风险）；
  自动命中只常驻「名字 + 适用场景」，正文由 Agent 自取。`messages.skills` 记录每轮用了哪些。
- 工具随用随装：技能正文提到命令行工具时，**Agent 在沙箱内自己 `npm i -g`**（用户不必知道包名）。
  前提是沙箱全局 prefix 指向共享卷 `npm-global`（容器内 `/pnpm-store/npm-global`）——
  容器 uid 1000 写不了 `/usr/local`，且 dash 的 login shell 会重置 PATH，
  故镜像里用 `/etc/profile.d/atoms-deps.sh` 前置该 bin；装一次跨容器重建保留。
  需要浏览器内核/系统库的工具沙箱内装不了，System Prompt 已说明。
- 安全：保存时扫描疑似凭据（连接串/私钥/JWT/签名/`key=value`）→ 列表与编辑器显示**警告标识**（只提示不阻断）；
  技能交付的是**知识**不是能力——不引入执行通道、不携带凭据（需要凭据的集成走未来的 MCP 层）。
- `/chat` 走 SSE；nginx 必须关 buffering。
- 额度：按积分（token 计量，见 `credits/`）；另有输入长度上限（4000 字）。

**统一错误契约**（异常状态对外的一致行为）：
- 所有错误响应都是 JSON `{ error, message }`；`app.onError` / `app.notFound` 兜底（默认实现会返回纯文本 `Internal Server Error`，前端只能显示「HTTP 500」且日志不过脱敏）。
- `message` 一定是**面向用户的中文可操作文案**；内部细节（沙箱路径、上游响应体、SQL、容器 IP）只进 `logErr`，绝不回传。
- A→B 调用统一 30s 超时（流式 `exec` 不设超时），连不上/超时归类为 `503 sandbox_unreachable`（「运行环境暂时不可用，请稍后重试」），不再落成通用 500。
- 「沙箱不可达」与「业务前置不满足」严格区分：前者 503 可重试，后者 4xx 并说明原因（例如发布时探测不到后端，不能静默按纯前端发布）。
- 启动期校验（`validateConfig`）：安全/核心项缺失（`SESSION_SECRET` 默认值、`APP_DATABASE_URL`、LLM Key、`SANDBOX_SHARED_SECRET`）→ 生产直接退出；功能降级项（`APPS_DOMAIN`/`RELEASE_DATABASE_URL`/`READONLY_DATABASE_URL`/COS 不完整）→ 告警。
- 沙箱侧 `/health` 含 docker 自检；反代统一 503 + 文案（不回传内部地址）。

## 8. 前端（React）

**响应式（移动端适配）**：
- 断点用 `lg`(1024px)：`<lg` 时左侧导航变成 **off-canvas 抽屉**（汉堡入口 + 遮罩，关闭时 `invisible` 以确保不进可访问性树/焦点），主区顶部有一条移动端顶栏；`≥lg` 保留可折叠静态侧栏（折叠状态持久化）。
- 工作台在 `<lg` 时是**单栏切换**：对话与「预览/文件/数据库/技能」面板互斥全屏，面板头部必须有**返回聊天**入口（曾是死胡同）。
- 表单控件在 `<lg` 强制字号 ≥16px（否则 iOS 聚焦会放大整页）；触控目标 `lg` 起再回到紧凑尺寸。
- 高度用 `100dvh`（带回退）+ `viewport-fit=cover`，底部交互区留 `env(safe-area-inset-bottom)`。
- 横向溢出防线：`truncate`（`white-space:nowrap`）的祖先若是 grid/flex 子项，必须给 `min-w-0`，否则子项 `min-width:auto` 会被撑到文本全宽（真实踩过：技能卡片被撑到 1076px）。
- 表格类内容用局部 `overflow-x-auto` + `whitespace-nowrap` 横向滚动，不要靠外层裁切。



```
<App>
  <Login/>
  <Projects/>                项目列表（重命名/删除）
  <Chat/>                    工作台
    ├─ 对话区：Markdown(Streamdown，懒加载) / Reasoning(可折叠) / ToolCard / TerminalBlock
    └─ 右侧：预览(iframe) / 文件管理器 / 数据库查看 / 发布分享
  <Credits/>                 积分明细页（余额 + 流水 + 按项目筛选）
```

**视觉体系（迭代 006）**
- **蓝图网格**：正交 1px 细线 + 顶部辉光，明暗两套 alpha（`--grid-line` / `--glow`），`.blueprint` 工具类。
- **双主题**：oklch token（`:root` 亮 / `.dark` 暗），三态（系统/亮/暗）持久化；首屏由 `index.html` 内联脚本落类名防闪。
- **字体**：全自托管且**同源**（Geist / Geist Mono / Noto Sans SC，中文按 `unicode-range` 分片按需下载），构建与运行均无外部字体请求。
- **品牌**：`Atoms` 字标 = 点阵 + 原子轨道（内联 SVG，与网格同构），用于登录页 / 顶栏 / 空态。
- **结构**：`AppShell` 全局外壳（字标 · 工具区 · 积分 · 主题 · 用户菜单）；token 在 `styles/tokens.css`，基础组件在 `components/ui/`。

**文件管理器（迭代 004）**
- 树形（`pid` → 层级，目录优先排序），VSCode 风格：右键菜单 + 悬停操作图标 + 顶部工具栏。
- 支持：新建文件/目录（含空目录）、CodeMirror 编辑（按扩展名高亮，`Cmd/Ctrl+S` 保存）、删除、重命名/移动。
- **生成中禁止编辑**；保存带 `version` 乐观锁，被 Agent 改动过则返回 409 并提示重新加载。
- 顶部「重新构建」= 前端 `pnpm -r build` + 重启开发预览后端（dev app 现为独立容器，可干净重启）。
- CodeMirror 懒加载（仅切到「文件」页时加载），避免拖大首屏包体。

- Markdown 用 **Streamdown**（面向流式），代码高亮 Shiki，中文断词 CJK。
- 思考内容 `reasoning` part 渲染为可折叠块（思考中展开、结束折叠）。
- 生成中可「停止」，失败可「重试」。

## 9. 预览与发布

### 预览（开发中）
- 预览走**独立子域** `dev-<projectId>.atoms.lexmin.cn`：
  - `/` → 经隧道 → B 沙箱服务 → 开发沙箱内的 `apps/web/dist`
  - `/api/*` → 经隧道 → B 沙箱服务 → **独立 devapp 容器**（挂载同一开发工作区，连 `p<id>_dev`）
- dev app 跑在独立容器（`atoms-devapp-<id>`），便于「重新构建」时干净重启、且不受开发容器生命周期影响。
- 每轮生成结束后前端自动启动 dev app；`preview-version` 变化即刷新 iframe。
- **必须独立子域**：若同源（平台域下路径），生成应用里的相对路径 `/api/*` 会落到平台自己的 API，而非项目后端。

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

**数据隔离**：每个项目一个 schema（`p{projectId}_{dev|prod}`），在**独立应用库** `atoms_apps` 中；开发/生产分离，发布从空开始。发布容器用 `RELEASE_DATABASE_URL`（A 机公网，因容器在 B）连接应用库。

### 三层隔离（开发 vs 线上）

| 维度 | 开发 | 线上（发布） |
|---|---|---|
| 数据 | `p<id>_dev` schema | `p<id>_prod` schema |
| 前端 | 工作区 `apps/web/dist`（经 `dev-<id>` 子域预览） | 发布时快照进 COS |
| 后端代码 | 开发工作区 `/srv/atoms/<id>`（Agent 实时编辑） | **冻结副本** `/srv/atoms-releases/<id>` |

发布时把开发工作区源码（排除 `node_modules`/`dist`/`.git`）**冻结成独立副本**，发布容器只挂载副本——因此 Agent 改动开发代码**不会影响线上**。重新发布 = 重新冻结；下架 = 清理副本。

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
