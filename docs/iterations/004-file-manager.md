# 迭代 004 —— 文件管理器（树形 UI + 完整文件管理 + 迁移基建）

- **状态**：已完成
- **日期**：2026-09-19

## 背景与目标

文件面板目前是**扁平列表 + 只读**。本迭代升级为**树形文件管理器**，支持新建文件/目录、编辑（CodeMirror）、删除、重命名/移动，改动同步到开发沙箱。

同时，`files` 表要从「扁平路径」重构为「树形（pid）结构」——这是一次**破坏性 schema 变更**，借此建立**数据库迁移基建**（从此所有变更都带迁移，能处理线上已有数据）。

## 范围

**做：**
1. **迁移基建**：`schema_migrations` 表 + 序号迁移脚本 + `db:init` 自动执行
2. **数据模型**：`files` 表重构为树（`pid` / `type` / `version` + 冗余 `path`），含旧数据迁移
3. **后端 API**：树查询、新建文件/目录、保存（乐观锁）、重命名、删除、重建
4. **前端**：树形文件管理器（VSCode 风格）+ CodeMirror 编辑 + 「重新构建」

**不做：**
- 实时协同编辑
- 文件拖拽排序

## 方案

### 1. 迁移基建
```
apps/api/src/migrations/0001-files-tree.sql
```
- `schema_migrations(id, name, applied_at)` 记录已执行迁移。
- `db:init`：建基础表（`schema.sql`）→ 按序执行未跑的迁移。
- 迁移脚本**幂等 + 只增不改**；破坏性变更自带数据搬迁。

### 2. 数据模型（`0001-files-tree`）
新 `files` 结构：
```sql
files(
  id uuid pk default gen_random_uuid(),
  project_id uuid not null,
  pid uuid null,                 -- 父目录节点
  name text not null,            -- 单段名
  type text not null,            -- 'file' | 'dir'
  path text,                     -- 冗余完整路径（file/dir 都有，便于与 Agent/沙箱衔接）
  content text,                  -- file 才有
  version int not null default 1,
  updated_at timestamptz default now()
)
```
迁移逻辑（旧表 `files(project_id, path, content)` → 新表）：
- 对每个文件的 `path` 按 `/` 拆分，逐级建目录节点（不存在才建），最后建文件节点。
- 保留 `content`；`pid` 按父路径解析。

### 3. 后端 API
```
GET    /api/projects/:id/tree                 树（id/pid/name/type/path）
POST   /api/projects/:id/fs/file              新建文件 {pid, name, content}
POST   /api/projects/:id/fs/dir               新建目录 {pid, name}
PUT    /api/projects/:id/fs/file/:id          保存 {content, version}
PUT    /api/projects/:id/fs/node/:id/rename   重命名/移动 {newName, newPid?}
DELETE /api/projects/:id/fs/node/:id          删除（目录递归）
POST   /api/projects/:id/rebuild              重建（前端 build + 后端重启）
```
- 每次写操作：校验归属 → 落库 → **同步到沙箱工作区**（写/删/重命名对应文件）；目录递归处理。
- **乐观锁**：`PUT file` 带 `version`，不符返回 409。
- **生成中禁止写**：`status !== ready` 时后端拒绝（前端也禁用）。

### 4. 前端
- `FileTree`：树形，展开/折叠、文件/目录图标，VSCode 风格（右键菜单 + 悬停图标 + 顶部工具栏）。
- 编辑：CodeMirror（按扩展名高亮）；未保存标记；`Cmd/Ctrl+S` 保存。
- 409 → 提示「文件已被更改，请重新加载」。
- 顶部「重新构建」按钮（前端 build + 后端重启 + 刷新预览）。

## 验收标准

- [ ] 迁移：现有项目的文件正确迁移为树；旧数据不丢；重跑 `db:init` 幂等
- [ ] 树形展示，能新建**空目录**
- [ ] 新建/编辑/删除/重命名/移动生效，且**同步到开发沙箱**
- [ ] 目录删除/改名**递归**生效
- [ ] 生成中禁止编辑
- [ ] 未保存期间被 Agent 改动 → 保存返回 409 并提示
- [ ] 「重新构建」→ 前端更新 + 后端重启 + 预览刷新

## 风险与取舍

- `files` 表结构重构是破坏性变更，**迁移必须保证线上数据完好**（这是本迭代重点验证项）。
- 冲突用版本号乐观锁兜底，不做实时协同。
- 文件树与沙箱工作区的一致性：以 DB 为事实源，写操作后同步沙箱。

## 完成情况

- [x] 迁移基建（`schema_migrations` + `db:init` 自动执行）
- [x] `files` 树形重构迁移（`0001-files-tree.sql`，含旧数据搬迁）
- [x] 后端 fs API（树/新建/保存/重命名/删除/重建）
- [x] 前端树形文件管理器 + CodeMirror
- [x] 部署 + 线上端到端验证

### 与计划的偏差

1. **dev app 改为独立容器**：原方案「后端重启」在开发沙箱内无法干净实现（镜像无 `ps`/`pkill`，见踩坑 16）。改为 `atoms-devapp-<id>` 独立容器挂载同一工作区，`docker rm -f` 即可重启。
2. **`open` 增加自愈清理**：DB 为事实源，`open` 时先删掉沙箱里多出的文件再写入，保证重命名/删除残留能被清除。
3. **沙箱同步失败不阻断写请求**：同步为尽力而为，失败则丢弃工作区缓存，下次从 DB 全量重建；避免「DB 已更新但接口报错」。
4. **树构建逻辑抽到 `@atoms/shared`** 并补单测（6 例），便于前端复用与回归。
5. **前端懒加载 CodeMirror**：文件管理器按需加载（首屏包体维持在 ~459 kB）。
6. **新建支持 `a/b/c` 路径式命名**：自动补建中间目录（与输入框占位提示一致）；重命名仍限单段。

### 迁移验证（本地 + 线上）

| 项 | 本地 | 线上（A 机） |
|---|---|---|
| 旧文件数（迁移前） | 36 | 111 |
| 迁移后文件数 | 36（逐字节一致） | 111（逐字节一致） |
| 生成目录节点 | 10 | 31 |
| `pid` 链路错误 | 0 | 0 |
| 重复执行幂等 | ✅ | — |

### 线上端到端验证

- 新建目录/文件 → DB + 沙箱一致
- 目录重命名 → 子树 `path` 递归更新，沙箱旧路径删除、新路径写入
- 目录删除 → 递归删除，沙箱同步清空
- 保存乐观锁：错误 `version` → 409；正确 → 递增并同步沙箱
- 「重新构建」→ `pnpm install` + `vite build` 成功 + devapp 重启
- devapp 容器 `ready:true`，`dev-<id>.atoms.lexmin.cn/api/health` 返回应用后端响应
- 开发预览首页返回最新构建产物

## 后续项

- 迁移守则已写入 [docs/README.md](../README.md) 与 `docs/architecture.md`：**此后所有 schema 变更都必须带迁移并处理线上数据**。
- 可考虑：文件拖拽移动、实时协同、构建结果的后台化（当前 rebuild 同步等待）。

## 子项：工作台布局调整（预览为主）

- **状态**：进行中
- **背景**：文件管理器被压在固定 440–720px，编辑器憋屈；且产出物（预览/文件）才是主角。

### 范围

1. **左右互换**：左 = 工作台（预览/文件/数据库 tabs + 发布 + 部署横幅），右 = 对话。
2. **可拖拽分栏**：默认 70/30（左/右）；拖分隔条实时改比例并持久化到 `localStorage`；对话宽度 clamp `360–520px`；窗口 resize 重新 clamp。
3. **空状态引导**：项目无消息时对话占 45%，首次生成成功后回到 30%，此后不再自动变（用户拖过则以用户为准）。
4. **窄屏 <1024px**：不做分栏，沿用现有浮层切换。
5. **细节**：分隔条双击复位 70/30、支持键盘 ←/→（`role="separator"`）；文件 tab 不再写死 `md:w-[720px]`。

### 取舍

- 不引入分栏库，自己用 pointer 事件 + clamp，零新增依赖。
- 空状态判定用「无消息」（避免为拿文件数再加一次请求）；新项目两者皆空，效果一致。

### 完成情况

- [ ] 左右互换 + 可拖拽分栏
- [ ] 空状态 45% → 生成后 30%
- [ ] 窄屏浮层切换（回归）
- [ ] 键盘/双击可达性
- [ ] typecheck / lint / test / 线上验证
