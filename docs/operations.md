# 运维与稳定性

线上服务的运维手册：巡检、备份、故障排查与恢复。真实主机、密钥、域名见 `.agents/skills/atoms-deploy/local.env`（gitignored）。

## 一、当前已配置的自动保护

| 机制 | 位置 | 作用 | 日志 |
|---|---|---|---|
| pm2 开机自启 | A 机 `systemctl is-enabled pm2-ubuntu` | 重启机器后 `atoms-api` / `atoms-tunnel` 自动拉起 | `pm2 logs` |
| 巡检（每分钟） | A 机 `~/bin/atoms-watchdog.sh`（cron） | 检查本地 API 与 A→B 隧道；**连续两次**异常才重启对应进程 | `~/atoms-watchdog.log` |
| 数据库备份（每天 03:10） | A 机 `~/bin/atoms-backup.sh`（cron） | `pg_dump` 平台库 + 应用库，保留 7 天 | `~/backups/atoms/`、`backup.log` |
| 容器非交互 | 沙箱容器 `CI=true` | 避免 pnpm 无 TTY 时 `ABORTED_REMOVE_MODULES_DIR` 直接退出 | — |
| 沙箱并发回收 | B 机沙箱服务 | 池满时回收最久空闲容器（保留工作区文件），不阻塞用户 | `journalctl -u atoms-sandbox` |
| 上下文保护 | A 机 `context.ts` / `compress.ts` | 历史裁剪 + 超 80% 软上限自动归纳压缩，避免上游断流 | `pm2 logs atoms-api`（`[chat] 上下文 …`） |
| 进程级兜底 | A 机 `index.ts` | 未处理的 Promise 拒绝只记日志不退出（避免抖动导致整体重启）；未捕获异常记录后退出并交给 pm2 拉起 | `pm2 logs atoms-api` |
| 单轮时长上限 | A 机 `CHAT_MAX_ROUND_MS`（默认 15 分钟） | 上游卡死时不再无限等待；已完成的改动已落库，可继续下一轮 | `[chat]` 日志 |

## 二、排查顺序（从上到下）

```bash
# 1) 站点与 API
curl -fsS https://<DOMAIN>/api/health

# 2) A→B 隧道（在 A 机）
curl -fsS http://127.0.0.1:4000/health        # B 是否可达（含 docker 自检）
pm2 list | grep -E 'atoms-api|atoms-tunnel'   # 进程与重启次数

# 3) API 日志（在 A 机）
export PATH="$HOME/.local/share/fnm/node-versions/v22.23.1/installation/bin:$PATH"
pm2 logs atoms-api --lines 80 --nostream

# 4) 沙箱服务与容器（在 B 机）
systemctl status atoms-sandbox --no-pager | head -5
docker ps --format '{{.Names}}\t{{.Status}}'
sudo journalctl -u atoms-sandbox --since '30 min ago' --no-pager | tail -40

# 5) 某个应用容器自身（devapp / release）
docker logs --tail 60 atoms-devapp-<id>
```

常见症状 → 结论：

| 症状 | 多半是 | 处理 |
|---|---|---|
| 全局 5xx / 打不开 | A 机服务或 nginx | `pm2 restart atoms-api`；`sudo nginx -t && sudo systemctl reload nginx` |
| 对话/生成报「运行环境暂时不可用」 | 隧道断或 B 沙箱服务异常 | 巡检会自动重启；手工 `pm2 restart atoms-tunnel`、`sudo systemctl restart atoms-sandbox` |
| 预览 503 | devapp 没起来 | 项目页点「重新构建」；或看 `docker logs atoms-devapp-<id>` |
| 发布「永远正在启动」 | 发布容器起不来 | `docker logs atoms-release-<id>`；确认 prod schema 与角色正常 |
| 提示「同时运行的项目已达上限」 | 并发池满（正常保护） | 等空闲回收，或稍后重试 |

## 三、恢复数据库

```bash
# 在 A 机（会覆盖现有数据，谨慎）
gunzip -c ~/backups/atoms/platform-<日期>.sql.gz | psql "<DATABASE_URL>"
gunzip -c ~/backups/atoms/appdb-<日期>.sql.gz    | psql "<APP_DATABASE_URL>"
```

## 四、已知边界（线上可能遇到，属预期）

- **积分**：每月自动补满 `CREDITS_MONTHLY_GRANT`（默认 500 积分 ≈ $5 模型费用）；用尽会明确提示并说明恢复时间。
- **并发**：同时运行的开发沙箱上限 4（2C4G 机器），超出会回收最久空闲的项目，不丢代码。
- **上游模型**：偶发限流/断流会给出可重试提示；已完成的文件改动会落库，直接说「继续」即可。
- **发布数量**：常驻发布容器上限 5，超出需先下架。
- **登录限流**：同 IP + 账号连续失败 8 次会锁 15 分钟。

## 五、发布前检查清单

- [ ] `curl -fsS https://<DOMAIN>/api/health` 返回 200
- [ ] A 机 `pm2 list` 中 `atoms-api`、`atoms-tunnel` 均 online
- [ ] A 机 `~/bin/atoms-watchdog.sh` 退出码 0（隧道通）
- [ ] B 机 `systemctl is-active atoms-sandbox` = active，`docker ps` 有预期的应用容器
- [ ] 跑一次金路径：注册新账号 → 生成一个小应用 → 预览 200 → 发布 → 发布站点页面与 `/api/*` 均 200
- [ ] `~/backups/atoms/` 有当天的两份 dump（非 0 字节）
