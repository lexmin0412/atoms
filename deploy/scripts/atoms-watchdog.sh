#!/usr/bin/env bash
# Another Atoms 巡检（A 机）：本地 API + A→B 隧道。
# 连续两次失败才重启，避免偶发抖动打断正在进行的请求。
# 部署：cp 到 A 机 ~/bin/atoms-watchdog.sh && chmod +x && 每分钟 cron（见 atoms-deploy 技能）
set -uo pipefail

export PATH="$HOME/.local/share/fnm/node-versions/v22.23.1/installation/bin:$PATH"
LOG="${ATOMS_WATCHDOG_LOG:-$HOME/atoms-watchdog.log}"
FLAG=/tmp/atoms-watchdog-fail

check() { # url → http code（失败为空）
  curl -sf -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true
}

API=$(check http://127.0.0.1:3010/api/health)
TUNNEL=$(check http://127.0.0.1:4000/health)

if [ "$API" = "200" ] && [ "$TUNNEL" = "200" ]; then
  rm -f "$FLAG"
  exit 0
fi

if [ -f "$FLAG" ]; then
  echo "$(date -Is) 连续两次异常 api=$API tunnel=$TUNNEL → 重启对应进程" >>"$LOG"
  [ "$API" != "200" ] && pm2 restart atoms-api >/dev/null 2>&1
  [ "$TUNNEL" != "200" ] && pm2 restart atoms-tunnel >/dev/null 2>&1
  rm -f "$FLAG"
else
  echo "$(date -Is) 首次异常 api=$API tunnel=$TUNNEL，等待下一次确认" >>"$LOG"
  touch "$FLAG"
fi
