-- 0009: 单轮最大步数默认值上调为 200，用户可设范围调整为 100~300
-- 幂等：可重复执行。

alter table projects alter column max_steps set default 200;

-- 存量值归一：低于新下限（旧默认 30 及 5~99 的取值）统一按新默认 200，
-- 避免出现小于可设范围的存量配置。
update projects set max_steps = 200 where max_steps < 100;
