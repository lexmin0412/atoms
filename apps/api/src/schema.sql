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

-- 发布/分享（静态前端产物）
create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  token text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists share_files (
  token text not null,
  path text not null,
  content_b64 text not null,
  primary key (token, path)
);

create index if not exists deployments_project_idx on deployments (project_id);
