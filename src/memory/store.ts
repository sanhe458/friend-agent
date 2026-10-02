import type { Persistence } from '../store/persist.ts';

export interface MemoryItem {
  text: string;
  tags: string[];
  channel: string;
  at: number;
  /** 短期/会话级记忆为 true，前台可写；长期记忆由后台提炼 */
  hot: boolean;
}

/** 按 person 物理分片的内存版存储（M1 先用它，后续换 SQLite 实现同一接口） */
export class MemoryStore {
  #byPerson = new Map<string, MemoryItem[]>();
  #persist?: Persistence;

  constructor(persist?: Persistence) {
    this.#persist = persist;
    if (persist?.enabled) {
      for (const { personId, item } of persist.loadMemories()) {
        const list = this.#byPerson.get(personId) ?? [];
        list.push(item);
        this.#byPerson.set(personId, list);
      }
    }
  }

  write(personId: string, item: MemoryItem): MemoryItem {
    const list = this.#byPerson.get(personId) ?? [];
    list.push(item);
    this.#byPerson.set(personId, list);
    this.#persist?.saveMemory(personId, item);
    return item;
  }

  /** 自动召回：关键词打分，命中不足则回退到最近 k 条 */
  recall(personId: string, query: string, k = 5): MemoryItem[] {
    const list = this.#byPerson.get(personId) ?? [];
    return recallFrom(list, query, k);
  }

  all(personId: string): MemoryItem[] { return [...(this.#byPerson.get(personId) ?? [])]; }
}

export function recallFrom(list: MemoryItem[], query: string, k = 5): MemoryItem[] {
  if (list.length === 0) return [];
  const q = query.toLowerCase().split(/[\s,，。.!！?？、]+/).filter(Boolean);
  if (q.length === 0) return list.slice(-k);

  const scored = list
    .map((it) => {
      const hay = (it.text + ' ' + it.tags.join(' ')).toLowerCase();
      let s = 0;
      for (const t of q) if (hay.includes(t)) s += 1;
      return { it, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  return (scored.length ? scored.map((x) => x.it) : list.slice(-k)).slice(0, k);
}
