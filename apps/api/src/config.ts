import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// apps/api/src -> ../../../ = 仓库根
loadEnv({ path: resolve(here, '../../../.env') });

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://huangmin@127.0.0.1:5432/atoms',
  /** 应用库（用户项目数据），与平台库分离 */
  appDatabaseUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  /** 已发布应用（跑在 B 机容器里）连接数据库用的地址，通常是 A 机的可达地址 */
  releaseDatabaseUrl: process.env.RELEASE_DATABASE_URL ?? '',
  /** 只读角色（数据库查看用）：连接串与密码 */
  readonlyDatabaseUrl: process.env.READONLY_DATABASE_URL ?? '',
  readonlyPassword: process.env.READONLY_DB_PASSWORD ?? '',
  apiPort: Number(process.env.API_PORT ?? 8787),
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret',
  llm: {
    baseUrl: process.env.OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
    apiKey: process.env.OPENCODE_GO_API_KEY ?? '',
    model: process.env.DEFAULT_MODEL ?? 'deepseek-v4.1-flash',
  },
  sandbox: {
    url: process.env.SANDBOX_URL ?? 'http://127.0.0.1:4000',
    secret: process.env.SANDBOX_SHARED_SECRET ?? '',
  },
  /** 应用域名（发布 <id>.<APP_DOMAIN>、预览 dev-<id>.<APP_DOMAIN>）；未配置则不返回绝对 URL */
  appsDomain: process.env.APPS_DOMAIN ?? '',
  /**
   * 上下文软上限（token）。模型窗口可以很大（1M），但上游在 ~200k 附近就容易断流，
   * 因此用它作为实际预算：超过 80% 触发历史归纳压缩。
   */
  contextSoftLimit: Number(process.env.CONTEXT_SOFT_LIMIT ?? 200_000),
  /** credits：每自然月补满到该额度（1 积分 = $0.01） */
  creditsMonthlyGrant: Number(process.env.CREDITS_MONTHLY_GRANT ?? 500),
  /** 已发布应用后端在容器内监听的端口（与沙箱侧约定一致） */
  releasePort: Number(process.env.RELEASE_PORT ?? 3001),
  /** 前端产物托管（COS）；未配置则回退本地目录 */
  cos: {
    bucket: process.env.COS_BUCKET ?? '',
    region: process.env.COS_REGION ?? '',
    secretId: process.env.TENCENT_SECRET_ID ?? '',
    secretKey: process.env.TENCENT_SECRET_KEY ?? '',
  },
};

/**
 * 启动期配置校验。
 *
 * 分两档：安全/核心项缺失 → 直接退出（宁可起不来，也不要带病运行）；
 * 功能降级项 → 只告警（可用性优先，但日志里能查到原因）。
 */
export function validateConfig(): void {
  const fatal: string[] = [];
  const degraded: string[] = [];

  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret') {
    fatal.push('SESSION_SECRET 缺失或仍是默认值（会话可被伪造）');
  }
  if (!process.env.APP_DATABASE_URL) {
    fatal.push('APP_DATABASE_URL 缺失（用户项目数据库不可用）');
  }
  if (!config.llm.apiKey) {
    fatal.push('OPENCODE_GO_API_KEY 缺失（无法调用模型）');
  }
  if (!config.sandbox.secret) {
    fatal.push('SANDBOX_SHARED_SECRET 缺失（无法调用沙箱，生成/预览均不可用）');
  }

  if (!config.appsDomain) {
    degraded.push('APPS_DOMAIN 缺失（发布/预览不返回可访问地址）');
  }
  if (!config.releaseDatabaseUrl) {
    degraded.push('RELEASE_DATABASE_URL 缺失（发布的后端容器会连不上数据库）');
  }
  if (!config.readonlyDatabaseUrl) {
    degraded.push('READONLY_DATABASE_URL 缺失（数据库查看会退回管理连接，只读边界失效）');
  }
  const cosParts = [
    config.cos.bucket,
    config.cos.region,
    config.cos.secretId,
    config.cos.secretKey,
  ];
  if (cosParts.some(Boolean) && !cosParts.every(Boolean)) {
    degraded.push('COS_* 配置不完整（前端产物托管会失败）');
  }

  if (degraded.length) {
    console.warn(
      `[config] 功能降级告警：\n${degraded.map((d) => `  - ${d}`).join('\n')}`,
    );
  }
  if (fatal.length) {
    console.error(
      `[config] 启动配置校验未通过：\n${fatal.map((d) => `  - ${d}`).join('\n')}`,
    );
    if (process.env.NODE_ENV === 'production') process.exit(1);
    console.warn('[config] 非生产环境：继续启动');
  }
}
