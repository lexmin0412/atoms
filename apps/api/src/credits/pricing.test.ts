import { describe, expect, it } from 'vitest';

import { computeCredits, pickUsage, roundCredits, type Rates } from './pricing';

// deepseek-v4.1-flash @ opencode-go（USD / 1M tokens）
const RATES: Rates = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };

describe('computeCredits', () => {
  it('按 input/output 双费率折算，1 积分 = $0.01', () => {
    // 1M input ($0.15) + 1M output ($0.60) = $0.75 = 75 积分
    const credits = computeCredits(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      RATES,
    );
    expect(credits).toBeCloseTo(75, 6);
  });

  it('缓存命中的 input 不再按全价计（inputTokens 已包含 cacheRead）', () => {
    // 1000 input，其中 800 命中缓存：200*0.15 + 800*0.003 = 30.0024e-6 USD
    const credits = computeCredits(
      { inputTokens: 1000, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 800 } },
      RATES,
    );
    const expectedUsd = (200 / 1e6) * 0.15 + (800 / 1e6) * 0.003;
    expect(credits).toBeCloseTo(expectedUsd / 0.01, 9);
  });

  it('一次典型生成（1150 in / 12 out）≈ 0.018 积分', () => {
    const credits = computeCredits({ inputTokens: 1150, outputTokens: 12 }, RATES);
    expect(roundCredits(credits)).toBe(0.018);
  });

  it('缓存数超过 input 时不会算成负数', () => {
    const credits = computeCredits(
      { inputTokens: 10, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 999 } },
      RATES,
    );
    expect(credits).toBeGreaterThanOrEqual(0);
  });

  it('零用量为 0', () => {
    expect(computeCredits({}, RATES)).toBe(0);
  });
});

describe('pickUsage（结算来源选择）', () => {
  const none = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  it('有整体 usage 时优先用它', () => {
    const r = pickUsage({ inputTokens: 100, outputTokens: 5 }, { ...none, count: 3 });
    expect(r?.source).toBe('total');
    expect(r?.usage.inputTokens).toBe(100);
  });

  it('整体 usage 拿不到时退回到「已完成步」累计', () => {
    const r = pickUsage(null, {
      count: 2,
      input: 300,
      output: 40,
      cacheRead: 10,
      cacheWrite: 0,
    });
    expect(r?.source).toBe('steps');
    expect(r?.usage.inputTokens).toBe(300);
    expect(r?.usage.outputTokens).toBe(40);
    expect(r?.usage.inputTokenDetails?.cacheReadTokens).toBe(10);
  });

  it('整体 usage 报错后（undefined）同样走兜底', () => {
    const r = pickUsage(undefined, { ...none, count: 1, input: 50, output: 3 });
    expect(r?.source).toBe('steps');
  });

  it('一步都没完成则不结算', () => {
    expect(pickUsage(null, none)).toBeNull();
    expect(pickUsage({ inputTokens: 0 }, none)).toBeNull();
  });
});
