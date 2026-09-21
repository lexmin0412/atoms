-- 0010: 单轮最大步数默认值上调为 500（可设范围 100~1000）
-- 幂等：可重复执行。

alter table projects alter column max_steps set default 500;

-- 0009 把旧默认值（30）归一成了 200，那不是用户特意设置的低上限，
-- 一并抬到新默认；用户自己选过的其他值（如 100）保持不动。
update projects set max_steps = 500 where max_steps = 200;
