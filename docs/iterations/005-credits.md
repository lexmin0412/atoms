# 迭代 005 —— Credits 体系（计量 / 扣减 / 限制）

- **状态**：已完成
- **日期**：2026-09-20

## 背景与目标

现状只有粗粒度的「24h 50 条消息」限制，且 `/api/usage` 展示的是**共享的上游额度**（非按用户），没有任何按用户的计量与扣减。

本迭代把**按用户的 credits 计算与限制真正落地**：按 token 计量、按周期发放、逐步限制、余额与明细可见。
运维动作（手动调额、查看上游共享额度）由 **A 机本地 CLI** 承担，不做公网管理入口。

## 澄清结论

| # | 决策 |
|---|---|
| 1 | 计量口径：**按 token**（上游回传 input/output，含 reasoning；用多步之和） |
| 2 | 额度发放：**周期发放**，语义为「补满到固定额度」，未用完不累积 |
| 3 | 扣减时机：**逐步检查，超额中断**（`stopWhen` 优雅停止，不硬杀） |
| 4 | 计价：**锚定 USD**，定价表从 **models.dev** 自动同步；**1 积分 = $0.01（100 积分 = $1）** |
| 5 | 展示：**余额 + 消息内消耗 + 明细页** |
| 6 | 额度：**可配**（`CREDITS_MONTHLY_GRANT`，默认 **500** 积分/月 ≈ $5 ≈ 165 次生成） |
| 7 | 运维入口：**A 机本地 CLI**（手动调额 / 查上游额度） |

## 方案

### 1. 计量与定价
- 数据源：`https://models.dev/api.json`，取 `provider=opencode-go`、`model=DEFAULT_MODEL` 的
  `cost { input, output, cache_read, cache_write? }`（USD / 1M tokens）。
- 换算（1 积分 = $0.01）：

  ```
  billableInput = max(0, inputTokens - cacheRead - cacheWrite)   // inputTokens 已含缓存命中
  credits = (billableInput/1e6·r_in + out/1e6·r_out
             + cacheRead/1e6·r_cr + cacheWrite/1e6·r_cw) / 0.01
  ```

- 取数：`streamText` 的 **`result.usage`**（AI SDK v7 里即多步累计之和；`totalUsage` 是废弃别名）。
- 缓存：内存缓存（TTL 24h）+ 磁盘缓存；拉取失败回退内置兜底费率，**不阻塞聊天**。
- 存储：`numeric(14,4)`（内部 4 位，避免系统性少扣），展示 2 位。

### 2. 数据模型（迁移 `apps/api/src/migrations/0002-credits.sql`）

```sql
credit_accounts (user_id pk, balance numeric(14,4), granted_period text, updated_at)
credit_ledger   (id, user_id, delta, balance_after, reason, project_id, ref, meta jsonb, created_at)
alter table messages add column credits numeric(14,4)
```

- `reason` 取值：`grant`（周期发放）/ `usage`（生成消耗）/ `adjust`（手动调整，CLI 写入）。
- 迁移给**现有用户补初始额度**（补满到默认额度）并写一条 `grant` 流水；补发在 `db:init` 的 seed 步骤完成（用配置值，不硬编码在迁移里）。

### 3. 发放与重置
- 周期：自然月。发起生成时若 `granted_period <> 当期` → **补满到** `CREDITS_MONTHLY_GRANT` 并写 `grant` 流水。
- 幂等以 `granted_period` 为准（并发下用行锁）。

### 4. 扣减与限制
- **发起前**：余额 ≤ 0 → `402 insufficient_credits`（带恢复周期信息）。
- **生成中**：`stopWhen` 追加自定义条件，按累计 usage 折算 credits，超余额即**停止循环**，消息标注「额度用尽，已中断」。
- **生成后**：按实际 `result.usage` 扣减（允许扣成负），写 `usage` 流水 + 回写 `messages.credits`。
- 中断 / 上游失败同样按实际消耗扣；**拿不到整体 usage 时回退到 `onStepFinish` 累计的「已完成步」用量**（`pickUsage()`），避免这一轮白送。
- 结算用一次性 promise 防重复扣（`onEnd` / `onError` 都可能触发）。
- **并发**：账户行 `select ... for update` 防超扣。

### 5. 用户端展示
- 顶栏 `CreditsBadge`：剩余 / 本月额度。
- 消息内：assistant 消息尾部「本次消耗 X.XX 积分」。
- `/credits` 明细页：余额 + 流水（倒序、按项目筛选、分页）。

### 6. 运维 CLI（A 机本地执行，零网络暴露）

```bash
pnpm --filter @atoms/api credits grant --email <email> --amount <n> --note <备注>
pnpm --filter @atoms/api credits list  --email <email>
pnpm --filter @atoms/api credits usage            # 上游系统共享额度
```

### 7. 部署
- A 机：rsync → `db:init`（跑迁移 + 补发）→ build web → 静态目录 → `pm2 restart atoms-api`。
- `.env` 新增：`CREDITS_MONTHLY_GRANT`（只放服务端，绝不提交）。

## 验收标准

- [x] 迁移后现有用户有初始余额，且明细有 `grant` 记录
- [x] 一次真实生成后余额按 models.dev 费率正确扣减（数值可核对）
- [x] 余额 ≤ 0 时拒绝发起；生成中途超额会中断并在消息标注
- [x] 顶栏余额 / 消息内消耗 / `/credits` 明细页均正确
- [x] `typecheck` / `lint` / `test` 全绿，部署后线上验证

## 风险与取舍

- **上游共享额度仍是硬天花板**：credits 是它之上的按用户公平层，不能替代上游配额。
- **中断会产生半成品**（已确认接受）。
- 定价依赖 models.dev 可用性：有磁盘/内存缓存 + 内置兜底费率。
- 计费在「按次结算」粒度上做小数处理，内部保留 4 位小数避免系统性少扣。
- **重试的精确计费做不到**：上游不回传单次失败 attempt 的 usage；好在 v7 重试只重跑当前步、
  已完成步会保留，因此不会整轮白送，但仍可能少计一步。

## 完成情况

- [x] 迁移 0002 + 回填（含现有用户补发额度）
- [x] 定价模块（models.dev + 内存/磁盘缓存 + 兜底费率）
- [x] credits 服务（账户 / 周期发放 / 扣减 / 流水，行锁防超扣）
- [x] chat 接入（发起前校验、`stopWhen` 逐步预算中断、事后结算、消息消耗、按步兜底）
- [x] 用户端展示（顶栏余额 / 消息内消耗 / `/credits` 明细页）
- [x] 运维 CLI（grant / list / usage）
- [x] 部署与线上验证

### 验证

**本地**
- 迁移幂等；现有用户补发 500 且写入 `grant` 流水；重复 `db:init` 不重复发放。
- 真实生成：`data-credits` = 0.018 积分（≈$0.00018），余额扣减、`usage` 流水与 `messages.credits` 均正确；
  流水 `meta` 含 `usageSource` / `steps`。
- `credits/pricing.test.ts` 单测覆盖换算与来源选择（双费率、缓存不全价、缓存数超 input、三分支兜底）。

**线上（`atoms.lexmin.cn`）**
- 迁移后现有用户各补发 500；注册即发 500。
- 真实生成扣费 500 → 499.982，`/credits` 明细页与顶栏余额一致。
- CLI `credits usage` 可查上游共享额度。

## 后续项

- 可考虑：额度预警、按项目消耗排行、上游配额与 credits 联动。
- 若未来接入真实支付，需引入对账与退款语义。
