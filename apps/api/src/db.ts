import pg from 'pg';

import { config } from './config';

/** 平台库连接池：users / sessions / projects / files / messages / app_releases */
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/** 应用库连接池：各用户项目的业务 schema（dev_* / prod_*） */
export const appPool = new pg.Pool({ connectionString: config.appDatabaseUrl });

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params);
}

export function appQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return appPool.query<T>(text, params);
}
