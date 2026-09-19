import 'dotenv/config';

export const config = {
  port: Number(process.env.SANDBOX_PORT ?? 4000),
  host: process.env.SANDBOX_HOST ?? '127.0.0.1',
  secret: process.env.SANDBOX_SHARED_SECRET ?? '',
  image: process.env.SANDBOX_IMAGE ?? 'atoms-sandbox:latest',
  root: process.env.SANDBOX_ROOT ?? '/srv/atoms',
  network: process.env.SANDBOX_NETWORK ?? 'atoms-sandbox',
  memory: process.env.SANDBOX_MEMORY ?? '1g',
  cpus: process.env.SANDBOX_CPUS ?? '1',
  /** 空闲多久后回收容器（毫秒），默认 30 分钟 */
  idleTtlMs: Number(process.env.SANDBOX_IDLE_TTL_MS ?? 30 * 60 * 1000),
  /** 同时运行的沙箱上限（按内存计，2C4G 建议 4） */
  maxSandboxes: Number(process.env.SANDBOX_MAX ?? 4),
  /** 同时运行的【已发布应用】上限（常驻后端容器） */
  maxReleases: Number(process.env.SANDBOX_MAX_RELEASES ?? 5),
  /** 已发布应用后端在容器内监听的端口 */
  releasePort: Number(process.env.SANDBOX_RELEASE_PORT ?? 3001),
};

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '.next',
  '.turbo',
]);
