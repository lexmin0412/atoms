-- 0008: 上下文压缩状态 + 上轮真实输入 token
-- 幂等：可重复执行。
-- 说明：历史消息本身不删除（用户仍能看到完整对话），这里只记录"给模型用的摘要"。

alter table projects add column if not exists context_summary text;
alter table projects add column if not exists context_summary_count int not null default 0;
alter table projects add column if not exists last_input_tokens int;
