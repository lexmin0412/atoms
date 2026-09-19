import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// apps/api/src -> ../../../ = 仓库根
loadEnv({ path: resolve(here, '../../../.env') });

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://huangmin@127.0.0.1:5432/atoms',
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
};
