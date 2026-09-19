import { appPool, pool } from '../db';
import { grantAppDbReadonly, migratePlatform } from './migrate';

await migratePlatform();
await grantAppDbReadonly();

await pool.end();
await appPool.end();
