# 迭代 001 —— 体验补强与工程质量

- **状态**：进行中
- **日期**：2026-09-19

## 背景与目标

核心闭环已上线（对话 → 沙箱真实构建 → 预览 → 发布），但体验与工程基线仍有明显短板：

- **用户体验**：不能取消生成；不渲染 Markdown；**思考过程不展示，工具调用后长时间静默、无反馈**；新用户无引导；繁忙/失败态不友好。
- **工程质量**：0 测试、无 lint、无 CI，稳定性缺乏佐证。

本迭代目标：补齐最刺眼的体验短板，并建立最小工程质量基线（可测试、可校验、可持续集成）。

## 范围

**做：**
1. 取消生成 + 流式错误友好化 + 重试
2. Markdown 渲染（Streamdown，面向流式）
3. 思考内容渲染（可折叠，解决静默等待）
4. 示例模板 + 空态引导
5. 测试（Vitest）+ lint（oxlint）+ 格式化（oxfmt）+ CI（GitHub Actions）

**不做（明确排除）：**
- 产品差异化（单独立项讨论，见「风险与取舍」）
- 全栈预览、独立子域、沙箱出网白名单（属安全/能力路线图 M8–M10）

## 方案

### 1. 取消生成 + 错误友好化 + 重试
- 前端接入 useChat 的 `stop()`，生成中显示「停止」按钮。
- 后端：把上游/沙箱错误归类为可读文案（如「模型服务暂时不可用，请重试」「构建环境繁忙」），而非通用 `An error occurred.`。
- 失败时在消息旁提供「重试」按钮（重发最后一条用户消息）。
- 涉及：`apps/web/src/pages/Chat.tsx`、`apps/api/src/routes/chat.ts`。

### 2. Markdown 渲染（Streamdown）
- 使用 **`streamdown`**：Vercel 专为 AI 流式输出打造的 Markdown 渲染库，是 `react-markdown` 的 drop-in 替代，能优雅处理**未闭合/未完成**的 Markdown 片段。
- 代码高亮用 `@streamdown/code`（Shiki）；中文断词用 `@streamdown/cjk`。
- 关键 props：`isAnimating={status === 'streaming'}`（流式期间禁用复制等交互）；`animated` 需引入 `streamdown/styles.css`。
- Tailwind v4：在 `apps/web/src/index.css` 增加 `@source` 指向 monorepo 根 `node_modules` 下 streamdown 的 dist（注意 `../` 层级）。
- 仅渲染 assistant 的 `text` part；用户消息保持纯文本；`data-command` 终端块与工具卡片不受影响。
- 涉及：新增 `apps/web/src/components/Markdown.tsx`、`index.css`、`package.json`。

### 3. 思考内容渲染（可折叠）
- **数据源**：AI SDK 已产出 `reasoning` part（`reasoning-start/delta/end`），且我们已把它持久化进消息 parts，历史回放也能拿到。
- **渲染**：`part.type === 'reasoning'` 渲染为一个**可折叠块**（与工具卡片同风格）：
  - **流式中**：默认展开，标题显示「思考中…」（轻量动效），实时滚动展示思考文本；
  - **结束后**：自动折叠为「已思考 ⌄」，点击可展开。
- **目的**：解决「工具调用后模型思考阶段一直静默、无任何反馈」的问题，让等待可见。
- 涉及：`apps/web/src/pages/Chat.tsx`（`renderPart` + 新增 `Reasoning` 组件）。

### 4. 示例模板 + 空态引导
- 项目页/对话空态给出 3–5 个可点击示例（如「番茄钟」「待办清单」「数据看板」），点击即填充并发送。
- 涉及：`apps/web/src/pages/Chat.tsx`、`Projects.tsx`。

### 5. 测试 + lint + 格式化 + CI
- **测试**：Vitest，先覆盖**可单测的纯逻辑**——`signature`（HMAC 一致性）、`applyEdit` 的替换语义、`mimeOf` 的类型/路径解析。不追求覆盖率，追求「关键不变量有回归保护」。
- **lint**：**oxlint**（Rust，快），根脚本 `pnpm lint` / `pnpm lint:fix`；配置 `.oxlintrc.json`。
- **格式化**：**oxfmt**（Prettier 兼容，内置 import / package.json / Tailwind 类名排序），脚本 `pnpm fmt` / `pnpm fmt:check`；配置 `.oxfmtrc.json`（排除 docs 以免文案被重排）。
- **CI**：GitHub Actions，PR/push 跑 `pnpm -r typecheck && pnpm lint && pnpm fmt:check && pnpm test`。
- 涉及：`vitest`/`oxlint`/`oxfmt` 依赖、`*.test.ts`、`.oxlintrc.json`、`.oxfmtrc.json`、`.github/workflows/ci.yml`、根 `package.json` 脚本。

## 验收标准

- [ ] 生成中可点「停止」，请求确实中止
- [ ] 上游/沙箱失败时给出可读文案，且提供「重试」
- [ ] assistant 的 Markdown（标题/列表/代码块/表格）用 Streamdown 正确渲染并高亮，**流式未闭合场景不闪烁/不报错**
- [ ] 思考内容以可折叠块展示：思考中显示「思考中…」并有内容滚动，结束后自动折叠
- [ ] 空态有示例，点击可一键发起
- [ ] 存在 Vitest 用例且 `pnpm test` 通过（覆盖签名/编辑语义/mime）
- [ ] `pnpm lint`（oxlint）与 `pnpm fmt:check`（oxfmt）通过，CI 在 PR 上绿色
- [ ] 本地与线上（A 机）部署后上述均生效

## 风险与取舍

- **Markdown 用 Streamdown**（而非 react-markdown 直用/自研）：专为流式设计、内置高亮与安全处理；但需处理 Tailwind `@source` 路径与 `styles.css` 引入。
- **思考内容只做展示、不做交互**：避免过度设计。
- **测试只覆盖纯逻辑**：E2E（起沙箱）成本高，本迭代不铺，改为对「纯函数不变量」加保护。
- **差异化能力本迭代不做**：属产品决策，需单独立项（候选：生成物「被他人使用 + 数据回流」闭环）。
- **CI 需要 GitHub 仓库**：若尚未推送，CI 先落配置，推送后生效。

## 完成情况

- [x] 取消生成 + 错误友好化 + 重试
- [x] Markdown 渲染（Streamdown，懒加载；首屏由 1.15MB 降至 ~453KB）
- [x] 思考内容渲染（可折叠）
- [x] 示例模板 + 空态引导
- [x] 测试（Vitest 3 文件 / 8 用例）+ lint（oxlint）+ 格式化（oxfmt）+ CI

**自测与部署**：本地 `pnpm -r typecheck && pnpm lint && pnpm fmt:check && pnpm test` 全绿；已部署 A 机（https://atoms.lexmin.cn），**待人工验收**。
