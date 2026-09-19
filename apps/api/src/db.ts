import pg from 'pg';
import { config } from './config';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params);
}
