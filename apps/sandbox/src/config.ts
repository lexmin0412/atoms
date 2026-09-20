import 'dotenv/config';

/** 读数字：缺失或非法（NaN/<=0）时用兜底值，避免 NaN 让判断静默失效 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (raw !== undefined) {
      console.warn(`[config] ${name}="${raw}" 非法，回退为 ${fallback}`);
    }
    return fallback;
  }
  return n;
}

export const config = {
  port: num('SANDBOX_PORT', 4000),
  host: process.env.SANDBOX_HOST ?? '127.0.0.1',
  secret: process.env.SANDBOX_SHARED_SECRET ?? '',
  image: process.env.SANDBOX_IMAGE ?? 'atoms-sandbox:latest',
  root: process.env.SANDBOX_ROOT ?? '/srv/atoms',
  network: process.env.SANDBOX_NETWORK ?? 'atoms-sandbox',
  memory: process.env.SANDBOX_MEMORY ?? '1g',
  cpus: process.env.SANDBOX_CPUS ?? '1',
  /** 空闲多久后回收容器（毫秒），默认 30 分钟 */
  idleTtlMs: num('SANDBOX_IDLE_TTL_MS', 30 * 60 * 1000),
  /** 同时运行的沙箱上限（按内存计，2C4G 建议 4） */
  maxSandboxes: num('SANDBOX_MAX', 4),
  /** 同时运行的【已发布应用】上限（常驻后端容器） */
  maxReleases: num('SANDBOX_MAX_RELEASES', 5),
  /** 已发布应用后端在容器内监听的端口 */
  releasePort: num('SANDBOX_RELEASE_PORT', 3001),
  /** 开发预览应用后端在容器内监听的端口 */
  devAppPort: num('SANDBOX_DEVAPP_PORT', 3002),
};

if (!config.secret) {
  // 与 A 机 SANDBOX_SHARED_SECRET 必须一致：缺失时所有业务接口都会 401/500
  console.error('[config] SANDBOX_SHARED_SECRET 未设置：受保护接口将无法通过签名校验');
}

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '.next',
  '.turbo',
]);
