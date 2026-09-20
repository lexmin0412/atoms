---
name: atoms-deploy
description: >
  部署与运维 Atoms（控制面 A 机 / 数据面 B 机沙箱 / nginx+HTTPS / SSH 隧道）。
  当需要「部署 atoms」「更新线上」「重启 atoms-api」「重启沙箱服务」「改数据库 schema」
  「签/续证书」「线上出问题排查」，或修改了 apps/api、apps/web、apps/sandbox 后要发布时使用。
  **真实主机地址/密钥路径/域名不写在本文件里**，见同目录 gitignored 的 `local.env`。
tags: ["Deploy", "Atoms"]
---

# Atoms 部署与运维（模板）

> **先读 `local.env`**（同目录，gitignored）：里面是真实主机、SSH key、域名、路径。
> 下文用 `<A_HOST>` `<B_HOST>` `<DOMAIN>` `<SSH_KEY>` `<A_REPO>` `<B_REPO>` `<WEB_ROOT>` 等占位符。

本项目是**双机架构**，部署时必须分清改的是哪一端、发到哪台机器。

## 拓扑与凭据位置

| | A 机（控制面） | B 机（数据面 / 沙箱） |
|---|---|---|
| 公网 IP | `<A_HOST>` | `<B_HOST>` |
| 登录 | `ubuntu`，key `<SSH_KEY>` | 同左 |
| 仓库 | `<A_REPO>` | `<B_REPO>` |
| Node | `~/.local/share/fnm/node-versions/v22.23.1/installation/bin`（**必须 22.23.1**，22.0.0 不支持 pnpm） | 系统 `/usr/local/bin/node` |
| 进程 | pm2：`atoms-api`（:3010）+ `atoms-tunnel` | systemd：`atoms-sandbox`（`127.0.0.1:4000`） |
| 其他 | Postgres 库 `atoms`（`127.0.0.1:9688`）、nginx 站点 `<DOMAIN>`、静态 `<WEB_ROOT>` | Docker 镜像 `atoms-sandbox:latest`、网络 `atoms-sandbox`、工作区 `<SANDBOX_ROOT>` |

**A→B 连接**：不开放 B 公网端口。A 用 `atoms-tunnel`（pm2 跑 `<A_REPO>/tunnel.sh`，ssh `-L 4000:127.0.0.1:4000`）转发到 B 的沙箱服务。

**密钥**：`SANDBOX_SHARED_SECRET` 必须 A/B 两端一致（A 在 `<A_REPO>/.env`，B 在 `<B_REPO>/.env`）；LLM key 只在 A。`.env` 均被 rsync 排除、且已 gitignore——别手动覆盖。

## 部署流程

### 只改后端（apps/api）
```bash
rsync -az -e "ssh -o BatchMode=yes" apps/api/src/ <A_HOST>:<A_REPO>/apps/api/src/
ssh -o BatchMode=yes <A_HOST> 'export PATH="$HOME/.local/share/fnm/node-versions/v22.23.1/installation/bin:$PATH"; pm2 restart atoms-api && sleep 3 && curl -s https://<DOMAIN>/api/health'
```

### 只改前端（apps/web）
```bash
rsync -az -e "ssh -o BatchMode=yes" apps/web/src/ <A_HOST>:<A_REPO>/apps/web/src/
ssh -o BatchMode=yes <A_HOST> 'export PATH="$HOME/.local/share/fnm/node-versions/v22.23.1/installation/bin:$PATH"; cd <A_REPO> && pnpm --filter @atoms/web build && sudo cp -r apps/web/dist/* <WEB_ROOT>/'
```
> `vite` 产物**必须 cp 到 `<WEB_ROOT>`**，否则线上不更新。

### 改沙箱服务（apps/sandbox）
```bash
rsync -az -e "ssh -i <SSH_KEY>" apps/sandbox/src/ ubuntu@<B_HOST>:<B_REPO>/src/
ssh -i "<SSH_KEY>" ubuntu@<B_HOST> 'sudo systemctl restart atoms-sandbox && systemctl is-active atoms-sandbox'
```

### 改了数据库 schema（apps/api/src/schema.sql 或 migrations/）
**任何 schema 变更都必须带迁移**（`apps/api/src/migrations/<NNNN>-<name>.sql`，只增不改、幂等、含旧数据搬迁）。
**顺序：先把代码（含 migrations/）同步到 A，再在 A 上执行 `db:init`**（否则 A 用旧代码，新表/迁移不生效 → 线上 500）。
```bash
rsync -az -e "ssh -o BatchMode=yes" apps/api/src/ <A_HOST>:<A_REPO>/apps/api/src/   # 含 migrations/
ssh -o BatchMode=yes <A_HOST> 'export PATH="$HOME/.local/share/fnm/node-versions/v22.23.1/installation/bin:$PATH"; cd <A_REPO> && pnpm --filter @atoms/api db:init'
```
> 迁移前先备份相关表；迁移后逐字节 `diff` 验证。

### 改了 sandbox 源码 + api 源码（如新增沙箱路由）
**先发 B（新路由）再发 A**，否则 A 调 B 的新接口会 404。

### 重建沙箱镜像（apps/sandbox/docker/Dockerfile）
```bash
rsync ... apps/sandbox/docker/Dockerfile ubuntu@<B_HOST>:<B_REPO>/docker/
ssh ... ubuntu@<B_HOST> 'cd <B_REPO> && docker build -t atoms-sandbox:latest docker/ && docker rm -f $(docker ps -aq --filter name=atoms-)'
```

## 踩坑清单（都真实踩过）

1. **`pkill -f 'docker build'` 会把自己杀掉**：执行它的 shell 命令行里含同样字符串。用 `pkill -f 'docke[r] build'` 规避自匹配。
2. **镜像里别用 `apt-get install`**：容器内 apt 走 Debian 公网源，国内极慢。沙箱镜像只做 `npm i -g pnpm@10` + 写 `/usr/local/etc/npmrc`（内网镜像源）。
3. **corepack 预置 pnpm 无效**：`corepack prepare` 缓存在 root 的 HOME，运行时以 node 用户找不到 → 会重新下载。改用 `npm i -g pnpm`。
4. **本机 `pnpm install` 会跳过 esbuild 构建脚本** → `vite build` 失败。仓库根 `.npmrc` 必须有 `dangerously-allow-all-builds=true`。
5. **nginx 必须关 SSE buffering**，否则聊天/流式看不到逐字输出：`proxy_buffering off; proxy_set_header Connection ""; proxy_read_timeout 600s;`。
6. **nginx 必须单独代理 `/share/`**：公开分享链接由 API 提供，若不配置会被 `location /` 的 SPA 兜底吃掉（表现为「分享页变成平台首页」）。站点配置见仓库 `deploy/nginx/`。
7. **改 schema 忘同步/建表 → 线上 500**：`db:init` 之前必须先把 `schema.sql` 同步到 A（见上）。
8. **rsync 排除 `.env`**：改端口/密钥后要单独在目标机改 `.env`，否则线上还是旧配置。
9. **别用变量存含空格的 ssh 命令**：zsh 不做分词，`$SSH "cmd"` 会报 “no such file or directory”。直接内联。
10. **B 机端口不要开公网**：沙箱服务绑 `127.0.0.1`，用 SSH 隧道。`SANDBOX_HOST` 默认 `127.0.0.1`。
11. **证书**：单域名走 HTTP-01（webroot `<WEB_ROOT>`）；泛域名才需要 DNS API + DNS-01。签发后记得配置续期。
12. **浏览器把发布页下载而不是渲染**：`curl -I`（HEAD/无 Accept-Encoding）看着是 `Content-Disposition: inline`，但浏览器带 `Accept-Encoding` 时 **COS 会返回 `Content-Disposition: attachment`**（并 `Content-Encoding: gzip`）。前门 nginx 必须 `proxy_hide_header Content-Disposition; add_header Content-Disposition "inline" always;`，并用 `proxy_set_header Accept-Encoding "";` 不让上游压缩。**排查技巧**：用 `curl -H 'Accept-Encoding: gzip, deflate, br'` 复现浏览器行为。
13. **发布容器跨机连库**：已发布应用的后端容器跑在 **B 机**，而 Postgres 在 **A 机**，容器里写 `127.0.0.1:9688` 会 `ECONNREFUSED`。必须：
    - A 的 `.env` 设 `RELEASE_DATABASE_URL=postgres://<user>:<pwd>@<A公网>:9688/atoms_apps`（`databaseUrlFor` 优先用它）；
    - A 的 `pg_hba.conf` 放行 **B 机网段**并 `reload`；
    - `atoms` 角色要有 `CREATEDB`（每应用一个 schema 需要）：`alter role atoms createdb;`。
    - 注意密码里可能有 `#`、`?` 等，`grep -oE` 截取会出错——用 Python `urllib.parse` 解析 `.env` 里的连接串。
14. **开发/生产必须隔离三样**：数据（`p<id>_dev` / `p<id>_prod`，在独立应用库 `atoms_apps`）、前端（发布时 dist 快照进 COS）、**后端代码**（发布时把开发工作区**冻结成副本** `<RELEASES_ROOT>/<id>`，发布容器只挂该副本）。否则 Agent 改开发代码会影响线上。
15. **`<RELEASES_ROOT>` 目录需预先创建并 chown 给运行用户**，否则首次发布会 `EACCES: mkdir` 500。
16. **B 容器内没有 `ps`/`pkill`**（精简镜像）：清理容器内进程要遍历 `/proc/[0-9]*/environ` 匹配环境变量再 `kill`。
17. **只读角色对“后建的表”无权限**：建 schema 时的 `GRANT SELECT ON ALL TABLES` 只覆盖**当时已存在**的表；应用运行时新建的表没被授权 → 数据库查看报 `permission denied`。修复：查询前由拥有者**兜底补授权**（`ensureReadable`），或配 `ALTER DEFAULT PRIVILEGES ... GRANT SELECT`。
18. **dev app 是独立容器**（`atoms-devapp-<id>`，挂载同一开发工作区）。它**不受开发沙箱回收器管辖**——回收/销毁开发沙箱时必须一并 `stopDevApp(id)`，否则容器泄漏、且删工作区会影响其挂载。
19. **改迁移/表结构后 B 上旧的沙箱工作区仍是旧文件**：A 的 `open` 会先列出沙箱文件、删掉 DB 里不存在的再写入（自愈）。所以**同步失败不要吞掉**。
20. **`pnpm install` 在 A 上会提示 build scripts 被忽略**：正常（根 `.npmrc` 已放行），只要目标依赖目录存在即可。
21b. **应用库需要 `CREATEROLE`**：每项目独立数据库角色（`r_p<uuid>_{dev|prod}`）由 API 在运行时创建，
    管理角色必须是 `CREATEROLE`（`sudo -u postgres psql -d atoms -c 'alter role atoms createrole;'`），
    否则 `db:init` 会在「项目数据库角色」步骤报 `Only roles with the CREATEROLE attribute may create roles`。
    `db:init` 会为所有已存在 schema 回填角色（幂等）。
21c. **轮换数据库密码后要重建存量容器**：容器的连接串在启动时注入，改密码后旧容器会在重连时失败 ——
    用 `app_releases` 里 `db_schema is not null` 的记录重建发布容器，devapp/dev 沙箱会按需自动重建。
21d. **项目 schema 内的对象必须归项目角色所有**：生成的 app 启动常自跑迁移（`alter table add column`），
    只有增删改查权限 → `must be owner of table` → 应用启动即崩（devapp / 发布容器都挂）。
    `db:init` 会把存量表/序列 `alter ... owner to` 给项目角色；转移要求能 `SET ROLE`，
    故 provisioning 里显式 `grant <role> to <admin> with set true`（PG16 历史成员关系默认无 SET）。
    `atoms_ro` 由**项目角色自己的短连接**授权（只有 owner 能授）。schema 本身仍归管理角色。
21f. **Agent 自己装的 npm CLI 落在共享卷，注意宿主/容器路径不是同一个字符串**：宿主是 `<SANDBOX_ROOT>/.pnpm-store/npm-global`，
    容器内是 `/pnpm-store/npm-global`（`/pnpm-store` 是挂载点）。用宿主路径去容器里 `mkdir` 会 `Permission denied`。
    另外容器 `sh` 是 **dash，login shell 会重置 PATH**，所以 `-e PATH=...` 不生效——镜像里用
    `/etc/profile.d/atoms-deps.sh` 前置 `npm-global/bin`（**改了要重建镜像并删旧沙箱容器**）。
21g. **A→B 的 HMAC 时间戳是毫秒**（`String(Date.now())`）。用 `date +%s`（秒）会因超出 60s 容差被判 `expired`
    （手写调试脚本时很容易踩；沿用 `sign()` 的实现即可）。
21e. **`docker inspect` 对已停止容器返回字面量 `invalid IP`**（不是空串）：IP 判断必须正则校验
    （`^\\d{1,3}(\\.\\d{1,3}){3}$`），否则会拼出 `http://invalid IP:3002` → 代理 500 而非 503。
21. **credits 环境变量只在服务端 `.env`**：`CREDITS_MONTHLY_GRANT`（默认 500）、`APPS_DOMAIN`（发布/预览域名）。**改 schema/加表后必须先 rsync 再 `db:init`**。
22. **没有公网管理入口**：手动调额/查系统额度用 A 机本地 CLI —— `pnpm --filter @atoms/api credits grant|list|usage`。
23. **定价依赖 models.dev**：拉不到会回退内置兜底费率（日志里会 warn），不阻塞聊天。`.cache/` 已 gitignore。
24. **`rsync` 多个源文件 + 目录目标会把路径拍平**：`rsync a/b/package.json package.json host:~/repo/` 会把 `apps/api/package.json` 覆盖到仓库根。多文件替换必须逐条指定**完整目标路径**。

## 安全加固（迭代 007，重建服务器时照做）

**A 机**
- SSH 只允许密钥：`/etc/ssh/sshd_config.d/49-atoms-hardening.conf` 写
  `PermitRootLogin prohibit-password` + `PasswordAuthentication no` + `KbdInteractiveAuthentication no`，
  然后 `sshd -t && systemctl reload ssh`。
  ⚠️ **文件名必须排在 `50-cloud-init.conf` 之前**（sshd 取**首个**匹配值）；叫 `99-*` 会被 cloud-init 的 `yes` 压住。
- ufw：`allow 22,80,443` + 其它在跑的项目端口；**9688 只允许 B 机与办公网段**（`ufw allow from <ip> to any port 9688 proto tcp`）；
  `ufw --force enable` 前务必先放行 22，否则会被锁在外。
- Postgres 角色需要 `CREATEROLE`（见 21b）。

**B 机**
- 沙箱容器出网白名单：`/usr/local/sbin/atoms-sandbox-egress.sh` + systemd `atoms-egress.service`
  （独立链 `ATOMS_EGRESS` 挂在 `DOCKER-USER` 上；只放行 DNS/80/443 + 到 A 的 9688，其余 DROP 并打日志 `atoms-egress-drop:`）。
- 改完用一次性容器验证：443 与 A:9688 通、22/3306 被丢、容器内 `pnpm install` 正常。

## 验证与健康检查

```bash
curl -s https://<DOMAIN>/api/health                      # A 网关 + api
ssh ... <A_HOST> 'curl -s http://127.0.0.1:4000/health'   # A→B 隧道
ssh ... <B_HOST> 'systemctl is-active atoms-sandbox; docker ps --filter name=atoms-'
```

线上问题排查顺序：**nginx → api(pm2 logs atoms-api) → 隧道(curl :4000) → 沙箱(journalctl -u atoms-sandbox) → 容器(docker logs/ps)**。
