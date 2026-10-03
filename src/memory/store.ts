import type { Persistence } from '../store/persist.ts';

export interface MemoryItem {
  text: string;
  tags: string[];
  channel: string;
  at: number;
  /** 短期/会话级记忆为 true，前台可写；长期记忆由后台提炼 */
  hot: boolean;
}

/**
 * 每个人在内存里保留的记忆上限。
 *
 * ⚠️ 以前这里**不设上限**：`write` 只 push、从不裁剪，`loadMemories` 又是全量加载。
 * 长期跑下来（每天几轮对话、后台持续提炼长期记忆），`#byPerson` 会线性膨胀，
 * 而且每次 `recall` 都要给全量做一遍打分 —— 内存和 CPU 一起涨。
 * 库里按 person 有索引但也没有按条数修剪，等于两边都没有天花板。
 * 现在：内存保留最近 N 条（长期记忆本该由后台去重/提炼，不该无限堆原始条目）。
 */
const MEMORY_LIMIT_PER_PERSON = 300;

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
      // 老库里可能已经堆了远超上限的条目，加载后就地裁一次
      for (const [personId, list] of this.#byPerson) {
        if (list.length > MEMORY_LIMIT_PER_PERSON) {
          this.#byPerson.set(personId, list.slice(-MEMORY_LIMIT_PER_PERSON));
        }
      }
    }
  }

  write(personId: string, item: MemoryItem): MemoryItem {
    const list = this.#byPerson.get(personId) ?? [];
    list.push(item);
    // 超上限就一次删到上限（不是每条删 1 条，避免频繁 splice）
    if (list.length > MEMORY_LIMIT_PER_PERSON) {
      list.splice(0, list.length - MEMORY_LIMIT_PER_PERSON);
    }
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
