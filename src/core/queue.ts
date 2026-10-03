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
    // 注意：先建「链体」，再用链体自身做链尾比较——不能直接比较 finally 之后的返回值，
    // 那已经是另一个 Promise 了，`#chains` 里存的永远对不上，清理就会失效。
    let chain!: Promise<void>;
    chain = prev
      .then(async () => {
        this.#active.add(personId);
        try {
          await job({ drain: () => this.drain(personId) });
        } finally {
          this.#active.delete(personId);
          this.#slots.delete(personId);
        }
      })
      .catch((err) => { console.error('[queue]', personId, err); })
      // ⚠️ 链尾用完要清掉：以前只 set 不 delete，每人会永久留一条已 resolve 的 Promise
      //    （人一多就是稳定的内存泄漏）。只有「当前这条仍是链尾」时才删，
      //    否则会把后来者排进来的新链误删、破坏串行。
      .finally(() => {
        if (this.#chains.get(personId) === chain) this.#chains.delete(personId);
      });
    this.#chains.set(personId, chain);
    return chain;
  }
}
