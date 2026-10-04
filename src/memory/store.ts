import type { Persistence } from '../store/persist.ts';
import { embed, cosine } from '../models/embedding.ts';
import { rerank } from '../models/rerank.ts';

export interface MemoryItem {
  /** 库里的自增 id（后台补算向量时用它定位；内存里新建的条目写库后回填） */
  id?: number;
  text: string;
  tags: string[];
  channel: string;
  at: number;
  /** 短期/会话级记忆为 true，前台可写；长期记忆由后台提炼 */
  hot: boolean;
  /** 嵌入向量（内存持有 + 库里落盘）；没算过/算失败 = 无 */
  vec?: Float32Array;
  /** 算这个向量用的嵌入模型名 —— 换模型后旧向量不参与召回，并触发自动重算 */
  vecModel?: string;
}

/**
 * 记忆系统依赖的模型（每次用时现取，跟着配置热重载走）：
 * - embedding：配了才走语义召回；没配 = 维持老的关键词召回，行为完全不变
 * - rerank：可选的精排段，向量粗筛候选后重排一次
 */
export interface MemoryModelDeps {
  embedding?: () => { baseUrl: string; apiKey?: string; model: string } | undefined;
  rerank?: () => { baseUrl: string; apiKey?: string; model: string } | undefined;
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

/** 两路召回各取多少条进候选池，再交给融合/精排 */
const CANDIDATE_POOL = 20;

/** RRF（Reciprocal Rank Fusion）常数，业界常用值 */
const RRF_K = 60;

/** 查询向量的快速重试：免费端点偶尔 429/抖动，一次失败就整轮掉级太亏 */
async function queryVec(cfg: { baseUrl: string; apiKey?: string; model: string }, q: string): Promise<Float32Array | undefined> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await embed({ ...cfg, input: [q], timeoutMs: 15_000 });
      if (r.vectors[0]) return r.vectors[0];
    } catch (err) {
      if (i === 1) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return undefined;
}

/**
 * 按 person 物理分片的记忆存储。
 *
 * 召回链路（2026-10-03 起）：
 *   ① 配了嵌入模型 → 查询文本向量化，与每条记忆做余弦相似度（向量粗筛）
 *   ② 候选 = 向量 top ∪ 关键词 top（两路互补：专名/生僻词靠关键词，换说法靠向量）
 *   ③ 配了重排模型 → 候选精排取 top-k；没配 → RRF 融合排序取 top-k
 *   ④ 任何一步失败（没配/超时/报错）→ 原路退回关键词召回，**绝不阻塞对话**
 *
 * 向量写入：write() 同步入库，后台串行队列补算向量（算好 UPDATE 回库）。
 * 换嵌入模型后：启动时发现 vec_model 对不上就自动排队重算，无需人工迁移。
 */
export class MemoryStore {
  #byPerson = new Map<string, MemoryItem[]>();
  #persist?: Persistence;
  #deps: MemoryModelDeps;
  /** 串行嵌入队列：写入/重算的向量任务一条条来，不打爆提供商 */
  #chain: Promise<void> = Promise.resolve();

  constructor(persist?: Persistence, deps: MemoryModelDeps = {}) {
    this.#persist = persist;
    this.#deps = deps;
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
      // 嵌入模型可用时，把「没算过向量 / 换了模型」的旧记忆排队补算（后台慢慢来）
      this.#backfillAll();
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
    const id = this.#persist?.saveMemory(personId, item);
    if (id != null) item.id = id;
    // 有嵌入模型就后台补向量：write 保持同步（调用点不用 await），召回晚一点就绪没关系
    this.#enqueueVec(item);
    return item;
  }

  /**
   * 删一条记忆（面板「删除」按钮走这里）。
   * ⚠️ personId + id 双重约束：id 是全局自增，带上 personId 才不会误删别人的分片。
   * 向量没落库的内存条目（id 还没回填）按对象引用删。
   */
  forget(personId: string, id: number): boolean {
    const list = this.#byPerson.get(personId) ?? [];
    const i = list.findIndex((it) => it.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    this.#byPerson.set(personId, list);
    return this.#persist?.deleteMemory(personId, id) ?? true;
  }

  /**
   * 自动召回：语义（向量 + 重排）优先，任何一步不可用/失败退回关键词打分。
   */
  async recall(personId: string, query: string, k = 5): Promise<MemoryItem[]> {
    const list = this.#byPerson.get(personId) ?? [];
    if (list.length === 0) return [];
    const q = query.trim();
    if (!q) return list.slice(-k);

    const eCfg = this.#deps.embedding?.();
    if (!eCfg) return recallFrom(list, q, k);

    try {
      // ① 查询向量化（带一次快速重试，抗 429/瞬时抖动）
      const qvec = await queryVec(eCfg, q);
      if (!qvec) return recallFrom(list, q, k);

      // ② 向量路：余弦相似度排序（没向量的条目不参与，等关键词路兜）
      const vecScored: Array<{ it: MemoryItem; s: number }> = [];
      for (const it of list) {
        if (it.vec && it.vecModel === eCfg.model) {
          vecScored.push({ it, s: cosine(qvec, it.vec) });
        }
      }
      vecScored.sort((a, b) => b.s - a.s);
      const vecTop = vecScored.slice(0, CANDIDATE_POOL);

      // ③ 关键词路（原有打分逻辑抽出来复用）
      const kwScored = keywordScore(list, q);
      const kwTop = kwScored.slice(0, CANDIDATE_POOL);

      // 候选 = 两路并集（去重）
      const cand = new Map<MemoryItem, number>(); // item → 首次出现序
      let order = 0;
      for (const { it } of vecTop) if (!cand.has(it)) cand.set(it, order++);
      for (const { it } of kwTop) if (!cand.has(it)) cand.set(it, order++);

      if (!cand.size) {
        // 向量还没算好且关键词也全空 → 退最近的
        return list.slice(-k);
      }

      const items = [...cand.keys()];

      // ④ 精排：有重排模型就用它（只对 ≤2×POOL 条候选打一次分，代价很小）
      const rCfg = this.#deps.rerank?.();
      if (rCfg) {
        try {
          const hits = await rerank({
            ...rCfg, query: q,
            documents: items.map((x) => x.text),
            topN: k, timeoutMs: 15_000,
          });
          if (hits.length) {
            return hits.slice(0, k).map((h) => items[h.index]);
          }
        } catch { /* 精排失败 → RRF 兜底，别让一次 500 毁掉召回 */ }
      }

      // ⑤ RRF 融合：两路排名倒数加权（60 是业界常数，名次越靠前贡献越大）
      const fused = new Map<MemoryItem, number>();
      vecTop.forEach(({ it }, i) => fused.set(it, (fused.get(it) ?? 0) + 1 / (RRF_K + i + 1)));
      kwTop.forEach(({ it }, i) => fused.set(it, (fused.get(it) ?? 0) + 1 / (RRF_K + i + 1)));
      return [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, k)
        .map(([it]) => it);
    } catch {
      // ⚠️ 召回是回复链路上的一环：嵌入挂了（没 key/断网/超时）也必须继续回话，
      //    退回纯关键词 —— 宁可召回差点，不能回复没了。
      return recallFrom(list, q, k);
    }
  }

  /** 面板展示用：剥掉向量（Float32Array 序列化出去是几千个键的垃圾） */
  all(personId: string): Array<Omit<MemoryItem, 'vec'>> {
    return [...(this.#byPerson.get(personId) ?? [])].map((m) => {
      const { vec: _vec, ...rest } = m;
      return rest;
    });
  }

  /** 语义召回自测（面板「记忆」页调试用）：带分数与来源，不影响对话链路 */
  async probe(personId: string, query: string, k = 8): Promise<Array<{
    id?: number; text: string; tags: string[]; at: number; hot: boolean;
    score: number; source: 'vector' | 'keyword' | 'rerank';
  }>> {
    const list = this.#byPerson.get(personId) ?? [];
    const q = query.trim();
    if (!list.length || !q) return [];
    const eCfg = this.#deps.embedding?.();
    if (!eCfg) {
      return keywordScore(list, q).slice(0, k).map((x) => ({
        id: x.it.id, text: x.it.text, tags: x.it.tags, at: x.it.at, hot: x.it.hot,
        score: x.s, source: 'keyword' as const,
      }));
    }
    try {
      const qvec = await queryVec(eCfg, q);
      if (!qvec) return [];
      const vecScored = list
        .filter((it) => it.vec && it.vecModel === eCfg.model)
        .map((it) => ({ it, s: cosine(qvec, it.vec as Float32Array) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, CANDIDATE_POOL);
      const kwScored = keywordScore(list, q).slice(0, CANDIDATE_POOL);

      const cand = new Map<MemoryItem, number>();
      let order = 0;
      for (const { it } of vecScored) if (!cand.has(it)) cand.set(it, order++);
      for (const { it } of kwScored) if (!cand.has(it)) cand.set(it, order++);
      const items = [...cand.keys()];
      const kwOf = new Map(items.map((it) => [it, kwScored.find((x) => x.it === it)?.s ?? 0]));
      const vecOf = new Map(items.map((it) => [it, vecScored.find((x) => x.it === it)?.s ?? -1]));

      const rCfg = this.#deps.rerank?.();
      if (rCfg) {
        try {
          const hits = await rerank({
            ...rCfg, query: q, documents: items.map((x) => x.text),
            topN: k, timeoutMs: 15_000,
          });
          if (hits.length) {
            return hits.map((h) => ({
              id: items[h.index].id, text: items[h.index].text, tags: items[h.index].tags,
              at: items[h.index].at, hot: items[h.index].hot,
              score: h.score, source: 'rerank' as const,
            }));
          }
        } catch { /* 掉 RRF */ }
      }
      const fused = new Map<MemoryItem, number>();
      vecScored.forEach(({ it }, i) => fused.set(it, (fused.get(it) ?? 0) + 1 / (RRF_K + i + 1)));
      kwScored.forEach(({ it }, i) => fused.set(it, (fused.get(it) ?? 0) + 1 / (RRF_K + i + 1)));
      return [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, k)
        .map(([it, s]) => ({
          id: it.id, text: it.text, tags: it.tags, at: it.at, hot: it.hot,
          score: s, source: (vecOf.get(it) ?? -1) >= 0 ? ('vector' as const) : ('keyword' as const),
        }));
    } catch (err) {
      throw err; // probe 是显式调试接口，失败让面板看到原因
    }
  }

  /** 给所有「没向量 / 模型不匹配」的记忆排队补算（启动时自动跑一次） */
  #backfillAll(): void {
    const eCfg = this.#deps.embedding?.();
    if (!eCfg) return;
    for (const list of this.#byPerson.values()) {
      for (const it of list) {
        if (!it.vec || it.vecModel !== eCfg.model) this.#enqueueVec(it);
      }
    }
  }

  /** 入串行队列：算好向量就地更新内存对象 + 落库；失败静默（下次启动 backfill 会再试） */
  #enqueueVec(item: MemoryItem): void {
    this.#chain = this.#chain
      .then(() => this.#embedOne(item))
      .catch(() => { /* 一条失败不拖垮队列 */ });
  }

  async #embedOne(item: MemoryItem): Promise<void> {
    const cfg = this.#deps.embedding?.();
    if (!cfg || !item.text) return;
    const r = await embed({ ...cfg, input: [item.text], timeoutMs: 30_000 });
    const vec = r.vectors[0];
    if (!vec) return;
    item.vec = vec;
    item.vecModel = cfg.model;
    if (item.id != null) this.#persist?.saveMemoryVec(item.id, vec, cfg.model);
  }
}

/** 关键词打分（原有逻辑）：query 按标点/空白切开，命中文本或标签计 1 分 */
function keywordScore(list: MemoryItem[], query: string): Array<{ it: MemoryItem; s: number }> {
  const q = query.toLowerCase().split(/[\s,，。.!！?？、]+/).filter(Boolean);
  if (q.length === 0) return [];
  return list
    .map((it) => {
      const hay = (it.text + ' ' + it.tags.join(' ')).toLowerCase();
      let s = 0;
      for (const t of q) if (hay.includes(t)) s += 1;
      return { it, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
}

/**
 * 纯关键词召回（无嵌入时的完整回退路径；也是 recall 各失败分支的兜底）。
 * 命中不足则回退到最近 k 条。
 */
export function recallFrom(list: MemoryItem[], query: string, k = 5): MemoryItem[] {
  if (list.length === 0) return [];
  const q = query.toLowerCase().split(/[\s,，。.!！?？、]+/).filter(Boolean);
  if (q.length === 0) return list.slice(-k);

  const scored = keywordScore(list, query);
  return (scored.length ? scored.map((x) => x.it) : list.slice(-k)).slice(0, k);
}
