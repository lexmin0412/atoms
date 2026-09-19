-- 只读角色授权（在【应用库】执行）：只能读用户项目的业务 schema（p*_dev / p*_prod）。
-- 幂等：可重复执行。角色本身由部署脚本创建。

grant connect on database atoms_apps to atoms_ro;

-- 对已存在的项目 schema 授权（新建 schema 由 ensureDevSchema / ensureAppSchema 授权）
do $$
declare
  s text;
begin
  for s in select nspname from pg_namespace
            where nspname like 'p%\_dev' or nspname like 'p%\_prod' loop
    execute format('grant usage on schema %I to atoms_ro', s);
    execute format('grant select on all tables in schema %I to atoms_ro', s);
  end loop;
end $$;
