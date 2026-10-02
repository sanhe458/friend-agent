export interface Injection { text: string; at: number }

/**
 * per-person 串行队列 + 插话槽。
 *
 * - 同一个人同时只跑一轮（串行），避免人格状态打架。
 * - 用户在轮次进行中「插话」：消息进插话槽，在**下一个工具调用间隙**被取走（steering）。
 * - 没有活动轮次时 inject() 返回 false，调用方应改为开新轮。
 */
export class PersonQueue {
  #chains = new Map<string, Promise<void>>();
  #slots = new Map<string, Injection[]>();
  #active = new Set<string>();

  isActive(personId: string): boolean { return this.#active.has(personId); }

  /** 用户随时插话：活着的轮次才收 */
  inject(personId: string, text: string): boolean {
    if (!this.#active.has(personId)) return false;
    const arr = this.#slots.get(personId) ?? [];
    arr.push({ text, at: Date.now() });
    this.#slots.set(personId, arr);
    return true;
  }

  /** 工具调用间隙：取走并清空插话槽 */
  drain(personId: string): Injection[] {
    const arr = this.#slots.get(personId) ?? [];
    if (arr.length) this.#slots.set(personId, []);
    return arr;
  }

  run(personId: string, job: (ctx: { drain: () => Injection[] }) => Promise<void>): Promise<void> {
    const prev = this.#chains.get(personId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        this.#active.add(personId);
        try {
          await job({ drain: () => this.drain(personId) });
        } finally {
          this.#active.delete(personId);
          this.#slots.delete(personId);
        }
      })
      .catch((err) => { console.error('[queue]', personId, err); });
    this.#chains.set(personId, next);
    return next;
  }
}
