-- 0007: 项目级 Agent 设置（最大步数可由用户配置）
-- 幂等：可重复执行。

alter table projects add column if not exists max_steps int not null default 30;
