-- 0001: files 表从「扁平路径」重构为「树形结构」，并搬迁线上已有数据。
-- 幂等：可重复执行；已迁移过则跳过。

do $$
declare
  has_old boolean;
  r record;
  parts text[];
  acc text;
  parent_pid uuid;
  seg text;
  i int;
  n int;
  node_id uuid;
begin
  -- 旧结构判定：files 存在，但没有 id 列
  select
    exists(
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'files'
    )
    and not exists(
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'files' and column_name = 'id'
    )
  into has_old;

  if has_old then
    alter table files rename to files_old;
  end if;

  create table if not exists files (
    id         uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    pid        uuid,
    name       text not null,
    type       text not null check (type in ('file', 'dir')),
    path       text not null,
    content    text,
    version    int not null default 1,
    updated_at timestamptz not null default now()
  );
  create index if not exists files_project_idx on files (project_id);
  create unique index if not exists files_project_path_uniq on files (project_id, path);

  -- 旧数据搬迁：按 / 逐级建目录节点 + 文件节点
  if has_old then
    for r in select project_id, path, content from files_old loop
      parts := string_to_array(r.path, '/');
      n := array_length(parts, 1);
      parent_pid := null;
      acc := '';
      for i in 1..n loop
        seg := parts[i];
        acc := case when acc = '' then seg else acc || '/' || seg end;
        if i < n then
          select id into node_id from files
           where project_id = r.project_id and path = acc;
          if node_id is null then
            insert into files (project_id, pid, name, type, path, content)
            values (r.project_id, parent_pid, seg, 'dir', acc, null)
            returning id into node_id;
          end if;
          parent_pid := node_id;
        else
          insert into files (project_id, pid, name, type, path, content)
          values (r.project_id, parent_pid, seg, 'file', acc, r.content)
          on conflict (project_id, path) do update set content = excluded.content;
        end if;
      end loop;
    end loop;
    drop table files_old;
  end if;
end $$;
