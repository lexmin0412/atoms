import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config } from '../config';

/**
 * 定价：从 models.dev 拉取「按模型」的 USD 费率（每 100 万 token），
 * 换算成 credits（1 积分 = $0.01，即 100 积分 = $1）。
 *
 * 取不到时回退到内置默认费率，绝不阻塞聊天。
 */

const MODELS_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = resolve(process.cwd(), '.cache/models.json');

/** USD / 1M tokens */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 兜底费率（deepseek-v4.1-flash @ opencode-go），仅在拉取失败时使用 */
const FALLBACK_RATES: Rates = {
  input: 0.15,
  output: 0.6,
  cacheRead: 0.003,
  cacheWrite: 0,
};

/** 1 积分 = 0.01 美元 */
export const USD_PER_CREDIT = 0.01;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}

let memory: { at: number; data: unknown } | null = null;

function loadDisk(): { at: number; data: unknown } | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as {
      at: number;
      data: unknown;
    };
    return raw && typeof raw.at === 'number' ? raw : null;
  } catch {
    return null;
  }
}

function saveDisk(at: number, data: unknown) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ at, data }));
  } catch {
    // 缓存写失败不影响主流程
  }
}

async function loadModels(): Promise<unknown> {
  const now = Date.now();
  if (memory && now - memory.at < CACHE_TTL_MS) return memory.data;

  const disk = loadDisk();
  if (disk && now - disk.at < CACHE_TTL_MS) {
    memory = disk;
    return disk.data;
  }

  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const data = (await res.json()) as unknown;
    memory = { at: now, data };
    saveDisk(now, data);
    return data;
  } catch (err) {
    console.warn(
      '[credits] 拉取 models.dev 失败，使用缓存/兜底费率:',
      (err as Error).message,
    );
    if (disk) {
      memory = disk;
      return disk.data;
    }
    if (memory) return memory.data;
    return null;
  }
}

/** 查询某 provider/model 的费率；缺失字段按 0 计 */
export async function getRates(model: string, provider = 'opencode-go'): Promise<Rates> {
  const data = (await loadModels()) as Record<
    string,
    { models?: Record<string, { cost?: Record<string, number> }> }
  > | null;
  const cost = data?.[provider]?.models?.[model]?.cost;
  if (!cost) return FALLBACK_RATES;
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cache_read ?? 0,
    cacheWrite: cost.cache_write ?? 0,
  };
}

/** 按 usage 折算 credits（未做四舍五入，由调用方决定精度） */
export function computeCredits(usage: Usage, rates: Rates): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  // inputTokens 已含读缓存部分；拆出来按 cache_read 计价更贴近真实成本
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const billableInput = Math.max(0, input - cacheRead - cacheWrite);

  const usd =
    (billableInput / 1e6) * rates.input +
    (output / 1e6) * rates.output +
    (cacheRead / 1e6) * rates.cacheRead +
    (cacheWrite / 1e6) * rates.cacheWrite;
  return usd / USD_PER_CREDIT;
}

/** 已完成步的用量累计（流中断/重试时的兜底来源） */
export interface StepsUsage {
  count: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 选择本次结算用哪份 usage：
 *  - 有整体 usage（多步之和）→ 优先用它；
 *  - 拿不到（中断/重试失败）→ 退回到「已完成步」的累计；
 *  - 一步都没完成 → null（不扣）。
 */
export function pickUsage(
  total: Usage | null | undefined,
  steps: StepsUsage,
): { usage: Usage; source: 'total' | 'steps' } | null {
  if (total && (total.inputTokens ?? 0) > 0) return { usage: total, source: 'total' };
  if (steps.count > 0) {
    return {
      usage: {
        inputTokens: steps.input,
        outputTokens: steps.output,
        inputTokenDetails: {
          cacheReadTokens: steps.cacheRead,
          cacheWriteTokens: steps.cacheWrite,
        },
      },
      source: 'steps',
    };
  }
  return null;
}

/** 保留 4 位小数（内部账目精度） */ export function roundCredits(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** 展示用：2 位小数 */
export function displayCredits(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function currentModel(): string {
  return config.llm.model;
}
