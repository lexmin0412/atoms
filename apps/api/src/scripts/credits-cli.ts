/**
 * 运维 CLI（在 A 机本地执行，不经网络）：
 *
 *   pnpm --filter @atoms/api credits grant --email <email> --amount 500 --note "内测补偿"
 *   pnpm --filter @atoms/api credits list --email <email>
 *   pnpm --filter @atoms/api credits usage
 *
 */
import { config } from '../config';
import { adjust, currentPeriod, getBalance, listLedger } from '../credits';
import { pool } from '../db';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];

async function findUser(email: string): Promise<{ id: string } | null> {
  const r = await pool.query<{ id: string }>('select id from users where email = $1', [
    email,
  ]);
  return r.rows[0] ?? null;
}

async function grant() {
  const email = arg('email');
  const amount = Number(arg('amount'));
  const note = arg('note') ?? '';
  if (!email || !Number.isFinite(amount) || amount === 0 || !note) {
    console.error(
      '用法: credits grant --email <email> --amount <正/负整数> --note <备注>',
    );
    process.exit(1);
  }
  const user = await findUser(email);
  if (!user) {
    console.error(`找不到用户: ${email}`);
    process.exit(1);
  }
  const balance = await adjust(user.id, amount, note, 'cli');
  console.log(
    `${email}: ${amount > 0 ? '+' : ''}${amount} → 余额 ${balance.toFixed(2)} 积分（备注：${note}）`,
  );
}

async function list() {
  const email = arg('email');
  if (!email) {
    console.error('用法: credits list --email <email>');
    process.exit(1);
  }
  const user = await findUser(email);
  if (!user) {
    console.error(`找不到用户: ${email}`);
    process.exit(1);
  }
  const balance = await getBalance(user.id);
  const { rows } = await listLedger(user.id, { page: 1, pageSize: 10 });
  console.log(`${email}  余额 ${balance.toFixed(2)} 积分（周期 ${currentPeriod()}）\n`);
  console.log('时间                 类型        变动      余额    说明');
  for (const r of rows) {
    const note =
      (r.meta as { note?: string; period?: string; model?: string }).note ??
      (r.meta as { period?: string }).period ??
      (r.meta as { model?: string }).model ??
      '';
    console.log(
      `${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}  ` +
        `${r.reason.padEnd(10)}  ${Number(r.delta).toFixed(2).padStart(8)}  ` +
        `${Number(r.balance_after).toFixed(2).padStart(8)}  ${note}`,
    );
  }
}

async function usage() {
  const res = await fetch(`${config.llm.baseUrl}/usage`, {
    headers: {
      Authorization: `Bearer ${config.llm.apiKey}`,
      'User-Agent': 'another-atoms/1.0',
    },
  });
  if (!res.ok) {
    console.error(`上游 /usage 返回 ${res.status}`);
    process.exit(1);
  }
  const j = (await res.json()) as {
    usage?: Record<string, { percent: number; resetsAt: string; status: string }>;
  };
  const u = j.usage ?? {};
  for (const k of ['rolling', 'weekly', 'monthly']) {
    const v = u[k];
    if (v) console.log(`${k.padEnd(8)} ${String(v.percent).padStart(3)}%  ${v.status}`);
  }
}

switch (cmd) {
  case 'grant':
    await grant();
    break;
  case 'list':
    await list();
    break;
  case 'usage':
    await usage();
    break;
  default:
    console.error(
      '用法: credits <grant|list|usage> [--email ..] [--amount ..] [--note ..]',
    );
    process.exit(1);
}

await pool.end();
