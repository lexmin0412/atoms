-- 0004: Skills（用户自定义技能）
-- 幂等：可重复执行。
-- 说明：内置技能 v1 不做（后续如需，会以代码定义 + 单独的状态表实现，不进本表）。

create table if not exists skills (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  -- project_id 为 null 表示「用户级」（跨项目可用）；非 null 表示项目级
  project_id  uuid references projects(id) on delete cascade,
  name        text not null,
  -- 用于 Agent 自动命中（列表里常驻给模型）
  description text not null default '',
  body        text not null default '',
  -- 声明的 npm CLI 依赖（包名数组）
  deps        jsonb not null default '[]'::jsonb,
  -- 保存时扫描出的「疑似密钥」类别（只提示，不阻断）
  secret_flags text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists skills_user_idx on skills (user_id);
create index if not exists skills_project_idx on skills (project_id);

-- 同名约束：用户级（project_id is null）与项目级分别唯一
create unique index if not exists skills_user_name_uniq
  on skills (user_id, lower(name)) where project_id is null;
create unique index if not exists skills_project_name_uniq
  on skills (user_id, project_id, lower(name)) where project_id is not null;

-- 记录每轮用到的技能（可追溯「这次为什么这么干」）
alter table messages add column if not exists skills text[];
