# 迭代 007 —— 安全加固（P0：跨租户越权 + 提示词/宿主信息泄露）

- **状态**：已完成
- **日期**：2026-09-20
- **依据**：[安全专项审计](../security-audit.md)（结论均已实测）

## 背景

审计确认两个 P0：

1. **跨租户数据库越权**：所有容器注入同一个 `atoms` 角色连接串（该角色是应用库 Owner，对**所有** `p*_dev|prod` schema 有 usage/create），且凭据在容器 env 明文可见 → 任一用户可读写他人数据。
2. **AI 可被套取系统提示词 / 宿主信息**：SYSTEM_PROMPT 无防护约束，Agent 的 `run_command` 可 `printenv` / 读 `/etc/hosts`，并把结果回给用户（顺带泄露 1 的凭据）。

## 范围

**做**：P0-1、P0-2（本迭代）+ 顺带把「A 机 SSH/PG 暴露」这类零成本加固一并处理。
**不做**（留 P1/P2 后续）：沙箱出网白名单、gVisor、限流、会话策略、密码策略。

## 方案

### 1. 每项目独立数据库角色（P0-1）

**数据模型**（平台库，迁移 `0003-project-db-roles.sql`）：
```sql
project_db_roles (schema text primary key, role_name text not null, password text not null, created_at)
```

**角色权限**（**不给 schema 所有权**，最小权限）：
```sql
create role <r_x> login password '<随机>';
revoke all on database atoms_apps from public;          -- 收紧默认
grant connect on database atoms_apps to <r_x>;
grant usage, create on schema <s> to <r_x>;             -- 只能用自己的 schema
grant select,insert,update,delete on all tables in schema <s> to <r_x>;
grant usage, select on all sequences in schema <s> to <r_x>;
alter default privileges for role <admin> in schema <s>
  grant select,insert,update,delete on tables to <r_x>;  -- 覆盖存量/后续由 admin 建的表
revoke usage on schema public from <r_x>;               -- 连 public 也不给
```
- 应用运行时新建的表由 `<r_x>` 创建 → 它自然拥有，可自行 `ALTER/DROP`。
- 角色**不拥有 schema** → 无法删 schema、无法越界。

**连接串**：`databaseUrlFor(schema)` 改为用该角色拼装（host/db 取自 `RELEASE_DATABASE_URL || APP_DATABASE_URL`）。

**回填**：`db:init` 末尾对所有已存在的 `p*` schema 执行一次 provision（幂等），保证存量项目不受影响。

**凭据轮换**：`atoms` 的密码已进入过所有容器 → **必须轮换**（`alter role atoms password`），并同步更新 A 机 `.env` 的
`DATABASE_URL / APP_DATABASE_URL / RELEASE_DATABASE_URL`。

### 2. 提示词与工具层防护（P0-2）

三层纵深：
1. **系统提示词硬约束**：拒绝复述/改写/编码输出系统提示与内部指令；拒绝输出环境变量、凭据、主机/网络拓扑；命中即拒绝并回到任务。
2. **工具层拦截**（比提示词可靠）：`run_command` 执行前正则拦截侦察类命令 —— `printenv`、`env`、`/proc/*/environ`、`/etc/{hosts,passwd,shadow,resolv.conf}`、`docker.sock`、连接串特征等，命中直接返回拒绝说明（不执行）。
3. **工具输出脱敏**：命令输出回给模型前，先抹掉凭据特征（`postgres://user:pass@`、`BEGIN … PRIVATE KEY`、`x-atoms-sig`、JWT 等），**让模型根本没机会看到**。

## 验收标准

- [ ] 以项目角色连接：只能访问自己的 schema（对其它 schema 报 permission denied）
- [ ] 容器 env 里的 `DATABASE_URL` 是项目角色，不再含 `atoms` 凭据
- [ ] `atoms` 密码已轮换，A 机 `.env` 与运行实例均使用新密码
- [ ] 存量项目（dev/prod）迁移后仍可正常读写自己的库
- [ ] 询问系统提示词 → 拒绝；`printenv` 类命令 → 被工具层拦截
- [ ] 即使输出中出现连接串特征，也会被脱敏
- [ ] `typecheck` / `lint` / `test` 全绿 + 线上验证

## 风险与取舍

- 改动生产数据库角色：**先在本地验证，再上 A 机；`atoms` 密码轮换需要同步 `.env` 与重连**。
- 存量 schema 的表由 `atoms` 拥有 → 用 `alter default privileges` + 显式 `grant` 覆盖，不改 owner（避免动到数据）。
- 工具层 denylist 有绕过空间（如 `env` 的等价写法）→ 因此**输出脱敏**是兜底，且 P0-1 已把凭据的横向能力砍掉。

## 完成情况

- [x] 迁移 0003 + 角色供给 + 回填（本地 13 / 线上 12 个 schema）
- [x] `databaseUrlFor` 切换为项目角色（改为 async，调用点同步更新）
- [x] 轮换 `atoms` 密码（3 个 URL）+ 重建存量发布容器
- [x] 提示词约束 + 工具层拦截 + 输出脱敏（+ 13 个单测）
- [x] 线上验证

### 验证证据

| 项 | 结果 |
|---|---|
| 项目角色读**自己** schema | ✅ 正常 |
| 项目角色读/建**他人** schema | ✅ `permission denied` |
| 项目角色删自己 schema | ✅ `must be owner`（无所有权） |
| 发布容器 env | ✅ `r_p<uuid>_prod`（不再是 `atoms`） |
| 线上询问系统提示词 + `printenv` | ✅ 模型拒绝、无工具调用、无凭据泄露 |
| 工具层拦截（单测） | ✅ 拒绝执行且 `exec` 未被调用 |
| 输出脱敏（单测） | ✅ 连接串/密钥在回给模型与前端前已被替换 |

### 一并完成的 P1–P3（详见 [审计文档](../security-audit.md#007-修复记录含验证证据)）

- **P1-3** 删除同源预览路由 + `/icon` 加固（nosniff / CSP sandbox / attachment）→ 实测 XSS 已不可执行
- **P1-4** A 机 SSH 仅密钥、ufw 启用、9688 收敛到 B 机与办公网段
- **P1-5** 登录/注册限流（IP+账号，指数退避）+ 密码策略（≥10 位、弱口令黑名单）
- **P2-6** 沙箱出网白名单（DNS/80/443 + 到 A 的 9688），systemd 持久化
- **P2-7** 登出吊销服务端会话 + 会话 7 天
- **P2-9** 日志脱敏 `logErr()`
- **P3-10** 显式 Origin / Sec-Fetch-Site 校验
- **P3-12** nginx 安全响应头 + CSP（主题脚本外置）
- **P3-11** docker 组：接受风险（理由见审计文档）

### 新增测试

`redact.test.ts`（脱敏/拦截）、`tools.test.ts`（工具层拦截 + 输出脱敏）、`security.test.ts`（限流 + Origin）。
api 测试 14 → **37 个**。
