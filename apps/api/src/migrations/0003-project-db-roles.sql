-- 0003: 每项目独立数据库角色（P0-1 跨租户越权修复）
--
-- 背景：原先所有应用/开发容器共用一个 Owner 角色连接应用库，
-- 凭据在容器 env 可见，且该角色对【所有】项目 schema 都有 usage/create。
-- 现改为「每项目一角色」，凭据记录在本表，角色只被授予自己 schema 的权限。
--
-- 幂等：可重复执行。

create table if not exists project_db_roles (
  schema     text primary key,
  role_name  text not null,
  password   text not null,
  created_at timestamptz not null default now()
);
