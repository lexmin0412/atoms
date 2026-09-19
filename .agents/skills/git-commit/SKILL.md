---

name: git-commit
description: >
  规范化 Git 提交流程。自动分析项目提交规范、生成符合 type(scope): message 格式的提交信息。
  当用户说"提交代码"、"commit"、"git commit"、"提交改动"、"提交一下"时触发。
  适用于所有 Git 仓库，自动检测并遵循项目已有的提交规范。
tags: ["Git"]
---

# Git Commit Skill

规范化 Git 提交流程，确保提交信息符合项目规范。

## 工作流程

### 1. 检测项目提交规范

按优先级查找规范来源：

1. **配置文件**：检查项目根目录是否存在：
   - `.commitlintrc` / `.commitlintrc.js` / `.commitlintrc.json`
   - `commitlint.config.js` / `commitlint.config.ts`
   - `package.json` 中的 `commitlint` 配置
   
2. **Git Hooks**：检查 `.husky/commit-msg` 或 `.git/hooks/commit-msg`

3. **历史提交**：如果无配置文件，分析最近 20 条提交信息：
   ```bash
   git log --oneline -20 --format="%s"
   ```
   从中提取：
   - 使用的 type 类型（feat/fix/docs 等）
   - scope 的格式（小写/中划线等）
   - message 的语言（中文/英文）
   - 是否使用 body

### 2. 分析暂存区改动

```bash
git status
git diff --cached --stat
git diff --cached
```

理解改动内容，确定：
- 改动类型（新功能/修复/重构等）
- 影响范围（模块/组件/配置等）
- 改动细节（用于 body 描述）

### 2.5 检查敏感信息

在提交前扫描待提交文件，检查是否存在敏感信息：

**检查范围：**
- 仅检查本次 `git add` 的文件（`git diff --cached --name-only`）
- 已被 `.gitignore` 忽略的文件跳过

**敏感信息模式：**
- API 密钥：`api_key`、`apikey`、`secret_key`、`access_key`、`token`
- 数据库：`password`、`passwd`、`db_pass`、`connection_string`
- 认证信息：`private_key`、`credentials`、`auth_token`
- 云服务：`aws_secret`、`aliyun_accesskey`、`oss_key`
- 其他：`密码`、`密钥`、`secret`、`credential`

**检查方式：**
```bash
git diff --cached --name-only | xargs grep -l -E "(api_key|apikey|secret_key|password|private_key|token)\s*[:=]\s*['\"][^'\"]{8,}" 2>/dev/null
```

**处理方式：**
- 发现疑似敏感信息 → 立即提醒用户，展示文件名和匹配行
- 等待用户确认是否继续提交
- 如果是误报（如示例代码、配置模板），用户确认后可继续

### 2.6 评估是否需要拆分提交

分析改动涉及的模块/功能/特性，判断是否需要拆分为多个提交：

**拆分原则：**
- 改动涉及多个独立模块/功能/特性 → 拆分
- 改动属于同一功能的不同层面（如 UI + 逻辑）→ 可合并
- 用户明确要求合并 → 不拆分

**拆分策略：**
- 按模块拆分：`feat(user): ...` + `fix(order): ...`
- 按功能拆分：`feat(auth): add login` + `feat(auth): add register`
- 按类型拆分：`feat(api): ...` + `test(api): ...`

**执行方式：**
- 先展示拆分建议，说明每个 commit 的范围
- 等待用户确认后，分批次 `git add` 并提交

### 3. 生成提交信息

#### 格式规范

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

#### Type 类型

| Type | 说明 |
|------|------|
| feat | 新功能 |
| fix | 修复 Bug |
| docs | 文档更新 |
| style | 代码格式（不影响功能） |
| refactor | 重构（非 feat/fix） |
| perf | 性能优化 |
| test | 测试相关 |
| build | 构建系统/依赖变更 |
| ci | CI 配置 |
| chore | 其他杂项 |
| revert | 回滚提交 |

#### Scope 规范

- 使用小写字母
- 多词用中划线连接（如 `user-profile`）
- 与项目已有 scope 风格保持一致

#### Subject 规范

- 使用命令式语气（"add" 而非 "added"）
- 首字母小写
- 不超过 50 字符
- 不以句号结尾

#### Body 使用场景

当改动满足以下条件时，添加 body：
- 涉及多个模块或文件
- 改动原因不明显
- 需要解释实现细节
- 存在破坏性变更

Body 格式：
- 空一行后开始
- 每行不超过 72 字符
- 说明改动的动机和对比之前的差异

### 4. 执行提交

确认提交信息后执行：
```bash
git commit -m "<type>(<scope>): <subject>" -m "<body>"
```

如果没有 body，则：
```bash
git commit -m "<type>(<scope>): <subject>"
```

## 示例

### 简单提交
```
feat(auth): add JWT token refresh mechanism
```

### 带 Body 的提交
```
fix(api): handle null response from payment gateway

The payment API sometimes returns null when the gateway is under heavy load.
Previously this caused a 500 error. Now we retry up to 3 times with exponential
backoff before returning a friendly error message to the user.

Closes #123
```

### 中文风格（跟随项目规范）
```
feat(user): 添加用户头像上传功能

- 支持 jpg/png 格式
- 自动压缩至 500KB 以下
- 生成缩略图
```

## 注意事项

- 提交前确保已完成 `git add`
- 如果没有暂存文件，提醒用户先暂存
- 尊重项目已有的语言风格（中文/英文）
- 破坏性变更必须在 footer 标注 `BREAKING CHANGE:`
- **拆分提交优先**：涉及多个模块/功能/特性时，默认拆分为多个 commit，除非用户明确要求合并
- **敏感信息检查**：提交前必须检查敏感信息，发现后立即提醒用户确认