# 迭代 003 —— 应用数据库查看（只读）

- **状态**：进行中
- **日期**：2026-09-19

## 背景与目标

已发布的应用（含后端 + 持久化）数据存在各自的 Postgres schema（`app_<短id>`）里，但平台侧**看不到**这些数据。本迭代提供**只读**的数据库查看：表列表、表结构、分页数据，让用户能直观确认应用的数据落库情况。

## 范围

**做：**
1. 只读数据访问层：专用只读角色 + 白名单校验
2. 后端只读 API：表列表 / 表结构 / 分页行数据
3. 前端：工作台右侧面板新增「数据库」tab（仅发布后可用）
4. **开发/生产库隔离**：开发沙箱连 `dev_<短id>`，发布容器连 `app_<短id>`（见下）

**不做：**
- 自定义 SQL 查询
- 编辑 / 删除数据（读写）

## 开发 / 生产库隔离 + 平台库/应用库分离（修订）

### 背景
原实现只有发布时创建 `app_<短id>`，开发沙箱没有 `DATABASE_URL` → Agent 连不上库。且**平台自身数据与用户项目数据同库**，隔离不够彻底。

### 设计
**两个数据库**：
| 库 | 内容 | 连接 |
|---|---|---|
| 平台库（`atoms`） | users / sessions / projects / files / messages / app_releases | 平台连接池 |
| 应用库（`atoms_apps`） | 各用户项目的业务 schema | 应用连接池（开发沙箱 / 发布容器）、只读池 |

**schema 命名**：`u{user8}_p{proj12}_{dev|prod}`
- `user8` = userId 去连字符前 8 位；`proj12` = projectId 去连字符前 12 位
- 例：`u1a2b3c4d_p5e6f7a8b9c0_dev`
- 长度 ~27，远低于 Postgres 63 字节上限（**必须压缩**，否则两个 UUID 直连会超限并被静默截断）

**环境隔离**：
- 开发沙箱连 `..._dev`（可随意折腾）
- 发布容器连 `..._prod`（数据受保护）
- 发布时 `_prod` 从空开始（不复制开发数据）
- 数据库查看器分「开发 / 生产」切换，且**仅当该 schema 真正有业务表时才显示入口**（纯前端项目不可见）

**清理**：已有测试 schema 直接清掉重建（不迁移）。

## 方案

### 1. 数据访问层（安全）
- 新增只读角色 `atoms_ro`：仅 `CONNECT`，对各 `app_*` schema `USAGE` + 表 `SELECT`；`ALTER DEFAULT PRIVILEGES` 保证新建表自动可读。
- 后端只读接口用 `atoms_ro` 连接（独立连接池），**默认 `search_path` 为空**，查询显式带 schema。
- **白名单**：表名先查 `pg_tables` 校验存在，列名查 `information_schema.columns`；标识符用双引号转义后拼接，行数据固定 `LIMIT/OFFSET` 参数化。

### 2. 后端 API（A）
```
GET /api/projects/:id/db/tables                       表列表（含行数估算）
GET /api/projects/:id/db/tables/:table                列定义
GET /api/projects/:id/db/tables/:table/rows?page=1    分页行数据（每页 50）
```
- 前置：项目属于当前用户；`app_<短id>` schema 存在（否则 404 `not_published`）。

### 3. 前端（A web）
- 右侧面板第 3 个 tab「数据库」（`preview | files | database`）。
- 404 → 「发布后可用」引导；有表 → 左表列表 + 结构 + 分页表格（横向滚动、NULL 灰显）。

### 4. 部署
- 建/维护只读角色与授权的脚本；`atoms-deploy` 记录。

### 5. 开发库注入（修订）
- `acquireWorkspace` / `ensureSandbox` 时确保 `dev_<短id>` schema 存在。
- 沙箱容器创建时注入 `DATABASE_URL`（指向 `dev_<短id>`，用 A 机可达地址）。
- 生成端 System Prompt 已要求用 `process.env.DATABASE_URL`，无需改动。

## 验收标准

- [ ] 含后端且已发布的项目，面板出现「数据库」tab，可列出表
- [ ] 能看表结构（列/类型/可空）与分页数据（每页 50）
- [ ] 未发布项目显示「发布后可用」
- [ ] 只读角色无法写入、无法读平台表（实测拒绝）
- [ ] 非法表名被拒绝（白名单生效）

## 风险与取舍

- 只读角色授权范围必须卡死（仅 `app_*` schema，禁平台表）。
- 分页用 `LIMIT/OFFSET`（demo 足够；超大表后续再优化）。
- 不做自定义 SQL（范围外）。

## 完成情况

- [x] 只读角色 + 白名单数据访问层
- [x] 后端只读 API（tables / columns / rows）
- [x] 前端「数据库」tab（开发/生产切换）
- [x] 部署与授权脚本
- [x] 开发/生产 schema 隔离 + 平台库/应用库分离（修订）
- [x] 预览独立子域（修复 `/api` 落到平台的问题）
- [x] 发布冻结源码副本（三层隔离：数据 / 前端 / 后端代码）

**验证**：
- 只读角色：能读项目 schema；读平台表 / 写入均 `permission denied`。
- 数据库查看：已发布项目 `prod.available=true`；未建表项目入口隐藏。
- 预览：`dev-<id>.atoms.lexmin.cn` 首页 200、`/api/health` 返回 `storage:postgres`（打到应用后端）。
- 隔离：开发工作区新增文件，发布容器不可见（跑冻结副本）。

**实施中的偏差与修复**：
- schema 命名从 `dev_/app_ + 截断` 改为 **`p{完整projectId}_{dev|prod}`**（截断会碰撞 + 超 63 字节）。
- 预览原为同源 → 生成应用 `/api` 落到平台；改为**独立子域**（M9）。
- 发布容器原挂开发工作区 → 改为**冻结副本** `/srv/atoms-releases/<id>`。

