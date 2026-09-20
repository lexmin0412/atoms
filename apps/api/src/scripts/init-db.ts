import { bootstrapCredits } from '../credits';
import { appPool, pool } from '../db';
import { provisionAllProjectRoles } from '../release/db';
import { grantAppDbReadonly, migratePlatform } from './migrate';

await migratePlatform();
await grantAppDbReadonly();

const seeded = await bootstrapCredits();
console.log(`[db:init] credits: 补发账户 ${seeded.users} 个`);

const provisioned = await provisionAllProjectRoles();
console.log(`[db:init] 项目数据库角色：已就绪 ${provisioned} 个 schema`);

await pool.end();
await appPool.end();
