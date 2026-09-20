-- 0005: 去掉 skills.deps
-- 迭代 008 改版：技能不再声明 CLI 依赖（用户不该需要知道 npm 包名）。
-- 技能里提到命令行工具时，由 Agent 在沙箱内按需自行安装
-- （全局 prefix 在共享卷上、目录可写且已在 PATH 中）。
-- 幂等：可重复执行。

alter table skills drop column if exists deps;
