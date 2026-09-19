create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists files (
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  content text not null default '',
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  seq int not null,
  role text not null,
  parts jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create index if not exists messages_project_seq_idx on messages (project_id, seq);
create index if not exists projects_user_idx on projects (user_id);
create index if not exists sessions_token_idx on sessions (token);

-- 发布（每个项目至多一个已发布应用，地址 = <projectId>.atoms.lexmin.cn）
create table if not exists app_releases (
  project_id uuid primary key references projects(id) on delete cascade,
  status text not null default 'stopped',   -- running | stopped | error
  frontend_target text,                      -- 前端产物目标（COS 前缀或本地目录）
  container_ip text,
  container_port int,
  db_schema text,                            -- 该应用的 Postgres schema
  error text,
  updated_at timestamptz not null default now()
);
