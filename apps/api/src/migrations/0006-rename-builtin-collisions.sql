-- 0006: 用户既有技能与【内置技能】重名时消歧
-- 内置技能由代码提供（不可改名/删除），若用户此前已建同名技能，
-- 列表会出现两个同名项、且注入时内置会遮蔽用户那份 → 把用户那份改名为「xxx-自定义」。
-- 不删除任何数据；幂等：改名后不再匹配 lower(name) = 'frontend-design'。
-- 注意：新增内置技能时，在此补一条（或抽象成通用列表）。

update skills s
   set name = s.name || '-自定义', updated_at = now()
 where lower(s.name) = 'frontend-design'
   and not exists (
     select 1
       from skills t
      where t.user_id = s.user_id
        and coalesce(t.project_id::text, '') = coalesce(s.project_id::text, '')
        and lower(t.name) = lower(s.name || '-自定义')
   );
