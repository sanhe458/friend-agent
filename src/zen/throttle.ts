/**
 * 免费车道 · 限流账本（ThrottleBook）。
 *
 * 移植自 zen-gate-server（internal/lane/throttle.go）。上游免费档没有余额接口，
 * 额度只会在被拒时自己暴露 —— 所以这里记的是「观察到的事实」：
 * - 实时 429 立刻标记（不等下一轮探测）；
 * - 冷却到时自动失效（不做永久拉黑）；
 * - 每次限额区间（episode）留档，用于估算恢复时间。
 *
 * 与上游实现逐条对齐的几处，都是当年踩过的坑：
 * - 值离开账本（回调 / 快照）一律深拷贝：结构体浅拷贝会共享 Episodes 数组，
 *   账本在锁内原地改它，锁外的读者就会 data race；
 * - 清理过期区间时**新开数组**，不能复用 `Episodes[:0]` 的底层数组；
 * - Clear() 会把仍开着的区间关掉，保留长度样本（换出口后估算还能用）。
 */

export interface ThrottleEpisode {
  start: number;
  /** 0 表示还没结束 */
  end: number;
}

export interface ThrottleNote {
  throttledAt?: number;
  cooldownUntil?: number;
  lastOk?: number;
  episodes?: ThrottleEpisode[];
}

const COOLDOWN_DEFAULT = 60_000;            // 上游没给 Retry-After 时按 1 分钟
const COOLDOWN_MAX = 2 * 3600_000;          // 2 小时封顶 —— 探测会再验证
const EPISODE_TTL = 14 * 24 * 3600_000;
const MAX_EPISODES = 12;

function cloneNote(n: ThrottleNote): ThrottleNote {
  return { ...n, episodes: n.episodes ? n.episodes.map((e) => ({ ...e })) : [] };
}

export class ThrottleBook {
  #notes = new Map<string, ThrottleNote>();
  /** 某模型的记录变化后触发（给持久化 / 面板刷新） */
  onUpdate?: (model: string, note: ThrottleNote) => void;

  /** 启动时恢复落盘的记录（限额区间历史不能因为重启就丢） */
  load(notes: Record<string, ThrottleNote> | undefined): void {
    if (!notes) return;
    for (const [m, n] of Object.entries(notes)) this.#notes.set(m, cloneNote(n));
  }

  /**
   * 丢掉所有模型的限额判定，但保留历史区间（换出口/换 IP 后调用）：
   * 额度按出口 IP 计，旧 IP 上的冷却结论对新 IP 没有意义。
   */
  clear(): void {
    const now = Date.now();
    const changed: Array<[string, ThrottleNote]> = [];
    for (const [m, n] of this.#notes) {
      if (!n.throttledAt) continue;
      for (const e of n.episodes ?? []) if (!e.end) e.end = now;
      n.throttledAt = 0;
      n.cooldownUntil = 0;
      changed.push([m, cloneNote(n)]);
    }
    for (const [m, n] of changed) this.onUpdate?.(m, n);
  }

  /** 记录一次实时限额。本轮第一次调用开启新区间，之后只延长冷却。retryAfterSec 是秒。 */
  markThrottled(model: string, retryAfterSec = 0): void {
    const now = Date.now();
    let cd = Math.round(retryAfterSec * 1000);
    if (!(cd > 0)) cd = COOLDOWN_DEFAULT;
    if (cd > COOLDOWN_MAX) cd = COOLDOWN_MAX;
    const n = this.#note(model);
    if (!n.throttledAt) {
      n.throttledAt = now;
      n.episodes = [...(n.episodes ?? []), { start: now, end: 0 }];
    }
    n.cooldownUntil = now + cd;
    this.#prune(n);
    this.onUpdate?.(model, cloneNote(n));
  }

  /** 一次成功（实时请求或探测）：关掉开着的区间、清掉冷却 */
  markOK(model: string): void {
    const now = Date.now();
    const n = this.#notes.get(model);
    if (!n) return;
    const changed = Boolean(n.throttledAt);
    n.lastOk = now;
    if (changed) {
      for (const e of n.episodes ?? []) if (!e.end) e.end = now;
      n.throttledAt = 0;
      n.cooldownUntil = 0;
      this.#prune(n);
      this.onUpdate?.(model, cloneNote(n));
    }
  }

  /** 当前是否在限额中；到点自动失效（下一次探测会确认真实恢复没有） */
  throttled(model: string): boolean {
    const n = this.#notes.get(model);
    if (!n) return false;
    this.#expire(n);
    return Boolean(n.throttledAt);
  }

  note(model: string): ThrottleNote {
    const n = this.#notes.get(model);
    if (!n) return { episodes: [] };
    this.#expire(n);
    return cloneNote(n);
  }

  all(): Record<string, ThrottleNote> {
    const out: Record<string, ThrottleNote> = {};
    for (const [m, n] of this.#notes) {
      this.#expire(n);
      out[m] = cloneNote(n);
    }
    return out;
  }

  /**
   * 估算某个限额中的模型何时恢复（epoch ms，0 表示不知道）：
   * 有 ≥2 段已结束的区间就取中位数，从其起点推算；否则用冷却边界。
   */
  recoveryETA(model: string): number {
    const n = this.#notes.get(model);
    if (!n || !n.throttledAt) return 0;
    const durs = (n.episodes ?? []).filter((e) => e.end > e.start).map((e) => e.end - e.start).sort((a, b) => a - b);
    if (durs.length >= 2) {
      const median = durs[Math.floor(durs.length / 2)];
      const eta = n.throttledAt + median;
      const now = Date.now();
      return eta < now ? now + 60_000 : eta;
    }
    return n.cooldownUntil ?? 0;
  }

  #note(model: string): ThrottleNote {
    let n = this.#notes.get(model);
    if (!n) {
      n = { episodes: [] };
      this.#notes.set(model, n);
    }
    return n;
  }

  #expire(n: ThrottleNote): void {
    if (n.throttledAt && Date.now() >= (n.cooldownUntil ?? 0)) {
      for (const e of n.episodes ?? []) if (!e.end) e.end = n.cooldownUntil ?? Date.now();
      n.throttledAt = 0;
      n.cooldownUntil = 0;
    }
  }

  #prune(n: ThrottleNote): void {
    const cutoff = Date.now() - EPISODE_TTL;
    // 新开数组：复用 n.episodes[:0] 会写穿到别处拿到的副本上
    let kept = (n.episodes ?? []).filter((e) => !e.end || e.end >= cutoff);
    if (kept.length > MAX_EPISODES) kept = kept.slice(kept.length - MAX_EPISODES);
    n.episodes = kept;
  }
}
