# 迭代 002 —— 发布成独立应用（全栈）

- **状态**：进行中
- **日期**：2026-09-19

## 背景与目标

当前「发布」实际只产出一个静态只读分享链接（`atoms.lexmin.cn/share/<token>/`），**不是可以直接线上使用的应用**。本迭代把「发布」升级为：给每个项目一个**独立可访问、能真正使用**的线上应用。

目标：点「发布」→ 得到 `https://<projectId>.atoms.lexmin.cn`，前端来自 COS，`/api` 打到该应用**常驻的后端容器**，数据持久化到独立 Postgres schema。

## 范围

**做：**
1. 发布流程：构建校验 → 前端上 COS → 后端起常驻容器 → 记录发布
2. 前门（A 机 nginx）：通配子域按 host 路由（`/api` → B 应用容器；`/` → COS）
3. 泛域名证书：acme.sh + DNSPod DNS-01，自动签发/续期
4. 每应用一个 Postgres schema，注入 `DATABASE_URL`
5. 生成端运行约定（写进 System Prompt 强制）
6. 生命周期：重新发布（地址不变）+ 下架；常驻**硬上限 5**
7. 取代 `/share`：移除静态快照分享，统一为「发布」

**不做：**
- 自定义域名绑定（非 `<id>.atoms.lexmin.cn`）
- 按需唤醒/休眠（本迭代采常驻 + 硬上限）
- 多副本 / 自动扩缩容

## 方案

### 1. 发布流程
```
点发布
 → 校验已构建（apps/web/dist 存在）
 → 前端：dist 上传 COS（<bucket>/apps/<projectId>/）
 → 后端：确保 Postgres schema app_<短id>；在 B 起常驻「发布容器」跑 apps/api
        （注入 PORT / HOST=0.0.0.0 / DATABASE_URL），记录容器地址+端口
 → 写 deployments；A nginx 按 host 路由
```

### 2. 前门（A 机 nginx）
- `server_name ~^(?<app>[0-9a-f-]+)\.atoms\.lexmin\.cn$`，泛域名证书
- `/api/` → `127.0.0.1:4000`（隧道 → B 沙箱服务 → 按 app 代理到容器）
- `/` → COS 源站（bucket 静态网站/回源）
- 同源 → 无 CORS

### 3. 生成端约定（System Prompt 强制）
- `apps/api`：提供 `start` 脚本；读 `process.env.PORT`；监听 `0.0.0.0`；路由挂 `/api/*`；用 `process.env.DATABASE_URL`
- 前端统一请求相对 `/api`；`vite.config` 设 `base: './'`

### 4. 数据
- 每应用一个 Postgres schema（`app_<短id>`），发布时创建；`DATABASE_URL` 只授该 schema 权限

### 5. 生命周期
- 重新发布：更新 COS 前端 + 重启后端容器（地址不变）
- 下架：停容器、链接失效、释放名额（schema 可选保留）
- 硬上限 5：满则拒绝发布并提示先下架

### 6. 取代 /share
- 移除 `share_files` / `/share` 路由与「静态快照发布」，统一为「发布」

## 验收标准

- [ ] 生成含后端的应用 → 发布 → `https://<id>.atoms.lexmin.cn` 能真实使用，数据重启不丢
- [ ] 重新发布生效（地址不变）；下架后链接不可用且释放名额
- [ ] 达到 5 个上限时拒绝并给出提示
- [ ] `*.atoms.lexmin.cn` 泛域名证书自动签发/续期
- [ ] 前门路由正确：`/` 来自 COS、`/api` 到容器

## 需要的前置凭据（仅服务端）

- 腾讯云 API 密钥（`SecretId` / `SecretKey`）：用于 ① acme.sh `dns_tencent` 签泛域名证书 ② COS 上传
- COS `bucket` 名 + `region`

## 风险与取舍

- 本迭代是**复杂度最高的一版**（DNS + 证书 + COS + 前门路由 + 常驻容器 + DB schema）。
- 2C4G 上 5 个常驻后端 + 发布瞬时构建，内存吃紧（靠上限 + 错峰）。
- 生成的用户后端可能崩溃/占资源 → 需健康检查 + 失败可观测 + 自动重启。
- 密钥（COS / DNSPod）只在服务端，绝不进前端或仓库。

## 完成情况

- [x] 发布流程（构建校验 / COS 上传 / 后端容器）
- [x] 前门路由（A nginx 通配子域：`/` 回源 COS、`/api` → 应用容器）
- [x] 泛域名证书（acme.sh + DNSPod DNS-01，自动续期）
- [x] 每应用 Postgres schema + `DATABASE_URL`（`search_path` 隔离）
- [x] 生成端运行约定（Prompt）
- [x] 生命周期（重新发布 / 下架 / 上限 5）
- [x] 移除 `/share`，统一为发布

**验证（端到端）**：
- 纯前端项目：发布 → `<id>.atoms.lexmin.cn` 200，资源来自 COS。
- 全栈项目（React + Hono + Postgres 待办）：`/api/health` `{ok:true,database:true}`；新增/查询/删除均生效；**重启容器后数据仍在**；数据落在独立 schema `app_<id>`。

**实施中的偏差与修复**：
- 前端托管：原计划 COS，实现中先本地兜底，后接入 COS（现为 COS 回源）。
- **COS 压缩响应会带 `Content-Disposition: attachment`** → 浏览器下载而非渲染；前门 nginx 屏蔽该头 + 禁上游压缩修复。
- **发布容器跨机连库**：容器在 B、库在 A，`127.0.0.1` 不通；新增 `RELEASE_DATABASE_URL`（A 公网）+ `pg_hba` 放行 B + `atoms` 角色 `CREATEDB`。
- 应用反代路径（`/sandbox/:id/app/*`）对公网开放，豁免 HMAC。

**后续项**：自定义域名绑定、按需唤醒/休眠、发布应用的多副本与扩缩容。

