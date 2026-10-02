export type Handler<T> = (evt: T) => void;

/** 极简事件总线：任务事件 → 回注会话 等异步链路走这里 */
export class Bus<Events extends Record<string, unknown>> {
  #map = new Map<string, Set<Handler<unknown>>>();

  on<K extends keyof Events & string>(key: K, h: Handler<Events[K]>): () => void {
    const set = this.#map.get(key) ?? new Set<Handler<unknown>>();
    set.add(h as Handler<unknown>);
    this.#map.set(key, set);
    return () => { set.delete(h as Handler<unknown>); };
  }

  emit<K extends keyof Events & string>(key: K, evt: Events[K]): void {
    for (const h of this.#map.get(key) ?? []) {
      try { h(evt); } catch (err) { console.error('[bus]', err); }
    }
  }
}
