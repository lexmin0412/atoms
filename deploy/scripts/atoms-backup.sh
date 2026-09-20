#!/usr/bin/env bash
# Another Atoms 数据库每日备份（平台库 + 应用库），保留 7 天。
# 部署：cp 到 A 机 ~/bin/atoms-backup.sh && chmod +x && 加 crontab（见 atoms-deploy 技能）
# 恢复：gunzip -c <file>.sql.gz | psql "<DATABASE_URL>"
set -euo pipefail

ENV_FILE="${ATOMS_ENV:-$HOME/code/atoms/.env}"
DEST="${ATOMS_BACKUP_DIR:-$HOME/backups/atoms}"
KEEP_DAYS=7
mkdir -p "$DEST"

read_env() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
raw = open(path, encoding='utf-8').read()
m = re.search(rf'^{re.escape(key)}=(.*)$', raw, re.M)
print((m.group(1) if m else '').strip().strip('"').strip("'"))
PY
}

dump() {
  local name="$1" url="$2"
  if [ -z "$url" ]; then
    echo "skip $name（未配置）"
    return 0
  fi
  # 连接串里可能有 #/? 等字符，统一用 urllib 解析，避免截断
  eval "$(python3 - "$url" <<'PY'
import sys, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
print(f"export PGHOST={u.hostname or '127.0.0.1'}")
print(f"export PGPORT={u.port or 5432}")
print(f"export PGUSER={urllib.parse.unquote(u.username or '')}")
print(f"export PGPASSWORD={urllib.parse.unquote(u.password or '')}")
print(f"export PGDATABASE={(u.path or '/').lstrip('/')}")
PY
)"
  pg_dump --no-owner | gzip >"$DEST/$name-$(date +%F).sql.gz"
  echo "  $name → $DEST/$name-$(date +%F).sql.gz"
  unset PGPASSWORD
}

echo "$(date -Is) 开始备份"
dump platform "$(read_env DATABASE_URL)"
dump appdb "$(read_env APP_DATABASE_URL)"
find "$DEST" -name '*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) 备份完成，当前保留："
ls -1t "$DEST" | head -4
