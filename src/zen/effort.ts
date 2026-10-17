/**
 * 免费车道 · 思考力度与输出预算。
 *
 * 移植自 zen-gate-server（internal/lane/effort.go）。要点：上游网关接受
 * reasoning_effort 一类参数后**直接忽略**，真正被执行的只有一个 —— max_tokens。
 * 所以这里的「力度」= 实打实的输出预算，不是提示词。
 *
 * 规则：力度天花板说了算，模型容量与调用方请求只能压低它、不能抬高。
 * 思考关不掉的模型（canDisableThinking=false）天花板翻倍，因为思考和正文共用一份预算。
 */
import type { ModelInfo } from './catalog.ts';

export interface Level {
  id: 'light' | 'balanced' | 'deep';
  name: string;
  zh: string;
  /** 0 = 用模型容量（deep） */
  ceiling: number;
}

export const LEVELS: Level[] = [
  { id: 'light', name: 'Light', zh: '精简', ceiling: 2_048 },
  { id: 'balanced', name: 'Balanced', zh: '均衡', ceiling: 8_192 },
  { id: 'deep', name: 'Deep', zh: '深思', ceiling: 0 },
];

export const DEFAULT_LEVEL: Level['id'] = 'balanced';
export const MIN_BUDGET = 512;
export const ALWAYS_THINKING_FACTOR = 2;

export function supportsEffort(m: ModelInfo): boolean { return m.reasoning; }

export function resolveLevel(level: string, m: ModelInfo): Level | undefined {
  if (!supportsEffort(m)) return undefined;
  return LEVELS.find((l) => l.id === level) ?? LEVELS.find((l) => l.id === DEFAULT_LEVEL);
}

/** 0 / 负数 → 不设限（Infinity），避免把「调用方没传」误判成「要 0 个 token」 */
function usable(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : Number.POSITIVE_INFINITY;
}

/**
 * 解析一次调用的输出预算。
 * level：显式力度（'' → 默认均衡）；requested：调用方要的 max_tokens；fallback：进程默认。
 */
export function budgetFor(level: string, m: ModelInfo, requested?: number, fallback?: number): number {
  let capacity = m.maxOutput > 0 ? m.maxOutput : 32_768;
  capacity = Math.min(capacity, usable(requested), usable(fallback));
  const lvl = resolveLevel(level, m);
  if (!lvl || lvl.ceiling === 0) return Math.max(MIN_BUDGET, capacity);
  const ceiling = m.canDisableThinking ? lvl.ceiling : lvl.ceiling * ALWAYS_THINKING_FACTOR;
  return Math.max(MIN_BUDGET, Math.min(ceiling, capacity));
}

export interface LevelBudget { id: string; name: string; zh: string; tokens: number; isDefault: boolean }

/** 面板上给这个模型展示的力度阶梯（与真正发请求用的是同一个预算函数） */
export function budgetLadder(m: ModelInfo, requested?: number, fallback?: number): LevelBudget[] {
  return LEVELS.map((l) => ({
    id: l.id, name: l.name, zh: l.zh,
    tokens: budgetFor(l.id, m, requested, fallback),
    isDefault: l.id === DEFAULT_LEVEL,
  }));
}

export function effortsFor(m: ModelInfo, requested?: number, fallback?: number): LevelBudget[] {
  return supportsEffort(m) ? budgetLadder(m, requested, fallback) : [];
}

/** 16384 → "16K" */
export function kilos(tokens: number): string { return `${Math.floor((tokens + 512) / 1024)}K`; }
