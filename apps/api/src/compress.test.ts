import { describe, expect, it } from 'vitest';

import { COMPRESS_RATIO, estimateTokens, shouldCompress } from './compress';

const SOFT = 200_000;

describe('estimateTokens', () => {
  it('中文：约 1 字 1 token（o200k 标定，cl100k 会翻倍）', async () => {
    expect(await estimateTokens('测'.repeat(1100))).toBe(1100);
  });

  it('英文句子与代码：BPE 真实计数', async () => {
    expect(await estimateTokens('The quick brown fox jumps over the lazy dog.')).toBe(10);
    expect(await estimateTokens('')).toBe(0);
  });

  it('对象按 JSON 计数（与请求体一致）', async () => {
    const n = await estimateTokens({ text: '测'.repeat(100) });
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(130); // 含 JSON 引号/字段名开销
  });
});

describe('shouldCompress', () => {
  const base = { softLimit: SOFT, messageCount: 20, lastInputTokens: null };

  it('未达阈值不压缩', () => {
    expect(shouldCompress({ ...base, estimatedTokens: SOFT * 0.5 })).toBe(false);
  });

  it('达到阈值（80%）压缩', () => {
    expect(shouldCompress({ ...base, estimatedTokens: SOFT * COMPRESS_RATIO })).toBe(
      true,
    );
    expect(COMPRESS_RATIO).toBe(0.8);
  });

  it('估算不高但上一轮真实值超阈值也压缩', () => {
    expect(
      shouldCompress({ ...base, estimatedTokens: 1000, lastInputTokens: SOFT * 0.9 }),
    ).toBe(true);
  });

  it('消息太少（没有可压缩的历史）不压缩', () => {
    expect(shouldCompress({ ...base, messageCount: 3, estimatedTokens: SOFT * 2 })).toBe(
      false,
    );
  });

  it('摘要已覆盖到压缩线附近时不重复归纳（避免每轮都调模型）', () => {
    // 20 条 → compressible = 14；摘要已覆盖 12 → 只差 2 条
    expect(
      shouldCompress({
        ...base,
        estimatedTokens: SOFT * 0.9,
        summaryCount: 12,
      }),
    ).toBe(false);
  });

  it('但真超软上限时仍立刻更新摘要', () => {
    expect(
      shouldCompress({
        ...base,
        estimatedTokens: SOFT * 1.2,
        summaryCount: 12,
      }),
    ).toBe(true);
  });

  it('force 时无条件压缩（便于手工触发）', () => {
    expect(
      shouldCompress({ ...base, messageCount: 2, estimatedTokens: 0, force: true }),
    ).toBe(true);
  });
});
