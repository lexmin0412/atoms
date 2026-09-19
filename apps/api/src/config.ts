import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// apps/api/src -> ../../../ = 仓库根
loadEnv({ path: resolve(here, '../../../.env') });

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://huangmin@127.0.0.1:5432/atoms',
  /** 已发布应用（跑在 B 机容器里）连接数据库用的地址，通常是 A 机的可达地址 */
  releaseDatabaseUrl: process.env.RELEASE_DATABASE_URL ?? '',
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
  /** 每用户 24 小时内最多可发送的消息数（防滥用） */
  dailyMessageLimit: Number(process.env.DAILY_MESSAGE_LIMIT ?? 50),
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
