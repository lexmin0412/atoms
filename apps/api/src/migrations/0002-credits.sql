-- 0002: credits 体系（账户 / 流水）+ messages.credits
-- 幂等：可重复执行。
-- 说明：账户的「初始发放」放在 db:init 的 seed 步骤（用配置的额度值），不在本迁移里硬编码。

create table if not exists credit_accounts (
  user_id        uuid primary key references users(id) on delete cascade,
  balance        numeric(14, 4) not null default 0,
  granted_period text,
  updated_at     timestamptz not null default now()
);

create table if not exists credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  delta         numeric(14, 4) not null,
  balance_after numeric(14, 4) not null,
  reason        text not null check (reason in ('grant', 'usage', 'adjust')),
  project_id    uuid,
  ref           text,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on credit_ledger (user_id, created_at desc);

alter table messages add column if not exists credits numeric(14, 4);
