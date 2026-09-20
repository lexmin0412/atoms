/**
 * 安全兜底：抹掉文本中的凭据特征、拦截侦察类命令。
 *
 * 分层防御里的最后一层 —— 即使命令被执行、或被模型从别处读到，
 * 只要经过这里回给模型/前端，敏感值就已经不存在了。
 */

const CONN_RE = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"`]+/gi;
const KEYVAL_RE =
  /((?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key|private[_-]?key|password|passwd|pwd|token|authorization|bearer)\s*[:=]\s*)([^\s'"`,;]{6,})/gi;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
/** 检测用（更松）：只要出现私钥头就算，哪怕被截断粘贴、没有 END */
const PRIVATE_KEY_HEAD_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const HMAC_RE = /\bx-atoms-(?:sig|ts)\s*[:=]\s*\S+/gi;

export function scrubSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(CONN_RE, '[redacted:db-url]')
    .replace(PRIVATE_KEY_RE, '[redacted:private-key]')
    .replace(JWT_RE, '[redacted:jwt]')
    .replace(HMAC_RE, '[redacted:signature]')
    .replace(KEYVAL_RE, '$1[redacted]');
}

/**
 * 扫描文本里的「疑似凭据」，返回人类可读的类别（用于 Skill 管理侧打警告标识）。
 * 只提示、不阻断 —— 是否真的泄露由用户判断。
 */
const SECRET_KINDS: { re: RegExp; label: string }[] = [
  { re: CONN_RE, label: '数据库连接串' },
  { re: PRIVATE_KEY_HEAD_RE, label: '私钥' },
  { re: JWT_RE, label: 'JWT' },
  { re: HMAC_RE, label: '签名/时间戳' },
  { re: KEYVAL_RE, label: '疑似密钥（key=value）' },
];

export function secretFindings(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const { re, label } of SECRET_KINDS) {
    re.lastIndex = 0;
    if (re.test(text)) found.push(label);
  }
  return found;
}

/** 看起来像凭据的整段文本（用于判断是否需要提示用户） */
export function looksSecret(text: string): boolean {
  CONN_RE.lastIndex = 0;
  PRIVATE_KEY_RE.lastIndex = 0;
  return CONN_RE.test(text) || PRIVATE_KEY_RE.test(text);
}

const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /^\s*printenv\b/, why: '读取环境变量' },
  { re: /^\s*env\s*$/, why: '读取环境变量' },
  { re: /^\s*set\s*$/, why: '读取当前 shell 变量' },
  { re: /^\s*export\s+-p\s*$/, why: '导出环境变量' },
  { re: /\/proc\/(?:\d+|self)\/environ/, why: '读取进程环境变量' },
  { re: /\/etc\/(?:hosts|passwd|shadow|resolv\.conf)/, why: '读取主机信息' },
  { re: /docker\.sock/, why: '访问容器运行时' },
];

/** 侦察类命令：直接拒绝执行（返回拒绝原因，命令不会真正跑） */
export function forbiddenReason(cmd: string): string | null {
  for (const f of FORBIDDEN) {
    if (f.re.test(cmd)) return f.why;
  }
  return null;
}

/**
 * 日志用：把错误压成一行并脱敏。
 * pg 等库的错误对象常常带回连接串/参数，直接 console.error(err) 会落盘敏感信息。
 */
export function errLine(err: unknown): string {
  const e = err as { code?: string; message?: string; detail?: string } | undefined;
  const parts = [e?.code, e?.message, e?.detail].filter(Boolean).join(' | ');
  return scrubSecrets(parts || String(err))
    .replace(/\s+/g, ' ')
    .slice(0, 400);
}

/** 统一的安全日志输出 */
export function logErr(scope: string, err: unknown): void {
  console.error(`${scope} ${errLine(err)}`);
}
