import { bootstrapCredits } from '../credits';
import { appPool, pool } from '../db';
import { grantAppDbReadonly, migratePlatform } from './migrate';

await migratePlatform();
await grantAppDbReadonly();

const seeded = await bootstrapCredits();
console.log(`[db:init] credits: 补发账户 ${seeded.users} 个`);

await pool.end();
await appPool.end();
