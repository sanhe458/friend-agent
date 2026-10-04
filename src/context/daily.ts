import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '../models/client.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { Persistence } from '../store/persist.ts';
import { messageText } from './tokens.ts';

/**
 * 每日上下文（三河 2026-10-04）：
 *
 * 以前的机制是「所有上下文堆在一起，快满了才压缩」——压缩摘要有损、还容易把
 * 早就过时的话题留在窗口里（上下文被污染）。现在改成**按天翻篇**：
 *
 *   ① 每天一份新的上下文：跨天后的第一条消息触发「翻篇」，当天从干净的历史开始；
 *   ② 前一天上下文的信息保留在记忆里：翻篇时由模型把旧上下文提炼成「当日摘要」
 *      写进记忆库（之后靠语义召回自动带回来）；
 *   ③ 上下文本身被归档：原始对话按天落盘成 JSON 文件；
 *   ④ AI 可以查询：`archive_query` 工具（tools/archive.ts）按天读 / 按关键词搜；
 *   ⑤ 归档保留 60 天：翻篇时顺手清理过期归档目录。
 *
 * 归档按 person 物理分片（与记忆隔离同一条约束）：每个人只能查到自己的那份。
 */

/** 归档保留天数 */
export const ARCHIVE_RETENTION_DAYS = 60;

/** 本地时区的自然日键（YYYY-MM-DD）——与调度器 daily: 的口径一致 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 一份归档：某个人某天的完整上下文（含翻篇时生成的摘要） */
export interface DailyArchive {
  personId: string;
  /** 这份上下文所属的自然日（当天最后一次活跃的日子） */
  day: string;
  archivedAt: number;
  /** 摘要文本（模型提炼；失败时为兜底文案） */
  summary?: string;
  /** 原始消息（role/content；tool_calls 不入档——归档是给人/AI 读的，不是给端点重放的） */
  messages: Array<{ role: string; content: string }>;
}

/** 一次翻篇的执行结果（给引擎发 notice 用） */
export interface RolloverResult {
  day: string;
  messages: number;
  summary: string;
  /** 归档文件路径 */
  file: string;
}

export interface DailyContextDeps {
  memory: MemoryStore;
  /** 归档根目录（约定：数据库同级的 archives/） */
  archiveDir: string;
  /** 摘要生成器（模型）；失败由翻篇流程兜底，不会卡住翻篇 */
  summarize: (text: string) => Promise<string>;
  persist?: Persistence;
  /** 归档保留天数，默认 60 */
  retentionDays?: number;
  log?: (s: string) => void;
}

/** personId → 文件名安全串（person id 本来就是 p_xxx，encode 只是兜底） */
const safeId = (id: string): string => encodeURIComponent(String(id || 'unknown'));

/** ISO 日期串校验（目录名只认这个形状，其它一律不碰） */
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

export class DailyContextManager {
  #deps: DailyContextDeps;
  #retention: number;
  /** 每个人「当前上下文属于哪一天」——由回复引擎在装载历史/每轮结束时标记 */
  #dayOf = new Map<string, string>();

  constructor(deps: DailyContextDeps) {
    this.#deps = deps;
    this.#retention = Math.max(1, deps.retentionDays ?? ARCHIVE_RETENTION_DAYS);
  }

  /** 这个人当前上下文属于哪一天（没有标记 = undefined） */
  dayOf(personId: string): string | undefined {
    return this.#dayOf.get(personId);
  }

  markDay(personId: string, day: string): void {
    this.#dayOf.set(personId, day);
  }

  #fileFor(day: string, personId: string): string {
    return join(this.#deps.archiveDir, day, `${safeId(personId)}.json`);
  }

  /**
   * 跨天检查 + 翻篇。返回 undefined = 还是同一天 / 没有可归档的历史（什么都没发生）。
   * 不等跨天、立刻翻篇走 rolloverNow（/new 命令用）。
   */
  async rolloverIfNeeded(personId: string, history: ChatMessage[], now = Date.now()): Promise<RolloverResult | undefined> {
    const today = dayKey(now);
    const day = this.#dayOf.get(personId);
    if (!day || day === today) return undefined;
    return this.rolloverNow(personId, history, now);
  }

  /**
   * 手动翻篇（/new 命令）：**跳过跨天检查**，立刻归档 → 提炼进记忆 → 清空。
   * 返回 undefined = 没有可归档的历史（此时只把日期标成今天）。
   *
   * 顺序刻意安排成「数据安全优先」：
   *   ① 原始上下文先落盘（这一步失败就整轮放弃，历史原样保留，下条消息再试）；
   *   ② 再提炼摘要写记忆（失败给兜底文案，不阻塞翻篇）；
   *   ③ 摘要回填进归档文件；
   *   ④ 清空持久层历史（内存里的由引擎清）；
   *   ⑤ 顺手清一次过期归档（每天至多一次，代价≈0）。
   */
  async rolloverNow(personId: string, history: ChatMessage[], now = Date.now()): Promise<RolloverResult | undefined> {
    const today = dayKey(now);
    // 归档日 = 这份历史所属的那天：优先取标记值——当天第一条消息就是 /new 时，
    // 历史其实还是昨天的，应归档到昨天（翻完再标成今天）
    const day = this.#dayOf.get(personId) ?? today;
    if (!history.length) {
      // 没有历史就没有可归档的东西，直接标成今天
      this.#dayOf.set(personId, today);
      return undefined;
    }

    const msgs = history.map((m) => ({ role: m.role, content: m.content ?? '' }));
    const file = this.#fileFor(day, personId);

    // ① 原始上下文落盘（先于摘要：摘要要花 token，落盘失败不该反复烧钱重试）
    try {
      mkdirSync(join(this.#deps.archiveDir, day), { recursive: true });
      const raw: DailyArchive = { personId, day, archivedAt: now, messages: msgs };
      writeFileSync(file, JSON.stringify(raw, null, 2));
    } catch (err) {
      this.#deps.log?.(`[日结] ⚠️ 归档写盘失败，保留上下文下条消息再试：${(err as Error).message}`);
      return undefined;
    }

    // ② 提炼成当日摘要，写进记忆（之后靠语义召回自动带回；旧对话不再占用上下文窗口）
    let summary: string;
    try {
      const text = history.map(messageText).join('\n').slice(0, 8000);
      summary = (await this.#deps.summarize(text)).trim() || '（空）';
    } catch (err) {
      summary = `（摘要生成失败：${(err as Error).message}；原始对话已归档，可查 ${day} 的记录）`;
    }
    try {
      this.#deps.memory.write(personId, {
        text: `【${day} 对话摘要】${summary}\n（当天原始对话已归档，archive_query 可查）`,
        tags: ['daily-summary', day],
        channel: '',
        at: now,
        hot: false, // 长期记忆：这是翻篇时后台提炼的产物，不是前台随手记的短期条目
      });
    } catch (err) {
      this.#deps.log?.(`[日结] ⚠️ 摘要写入记忆失败（归档不受影响）：${(err as Error).message}`);
    }

    // ③ 摘要回填进归档（失败不影响：原始文件已在 ① 落盘）
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as DailyArchive;
      doc.summary = summary;
      writeFileSync(file, JSON.stringify(doc, null, 2));
    } catch { /* 原始档还在 */ }

    // ④ 新的一天干净的上下文：持久层历史清空（内存那份由引擎自己清）
    try {
      if (this.#deps.persist?.enabled) this.#deps.persist.clearHistory(personId);
    } catch (err) {
      this.#deps.log?.(`[日结] ⚠️ 清空历史失败：${(err as Error).message}`);
    }

    // ⑤ 清理过期归档（保留 N 天，N 默认 60）
    let purged = 0;
    try { purged = this.purgeExpired(now); } catch { /* 清理失败不影响翻篇 */ }

    this.#dayOf.set(personId, today);
    this.#deps.log?.(
      `[日结] ${personId} 的 ${day} 上下文已翻篇：${msgs.length} 条归档 → ${file}${purged ? `；清理过期归档 ${purged} 天` : ''}`,
    );
    return { day, messages: msgs.length, summary, file };
  }

  /** 这个人有哪些天的归档（按日期升序；count=-1 表示文件损坏读不出来） */
  listDays(personId: string): Array<{ day: string; count: number }> {
    const out: Array<{ day: string; count: number }> = [];
    if (!existsSync(this.#deps.archiveDir)) return out;
    for (const name of readdirSync(this.#deps.archiveDir)) {
      if (!isDay(name)) continue;
      const f = this.#fileFor(name, personId);
      if (!existsSync(f)) continue;
      try {
        const doc = JSON.parse(readFileSync(f, 'utf8')) as DailyArchive;
        out.push({ day: name, count: Array.isArray(doc.messages) ? doc.messages.length : -1 });
      } catch {
        out.push({ day: name, count: -1 });
      }
    }
    return out.sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  /** 读某一天的归档；没有/越界返回 undefined */
  readDay(personId: string, day: string): DailyArchive | undefined {
    if (!isDay(day)) return undefined;
    const f = this.#fileFor(day, personId);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as DailyArchive;
    } catch {
      return undefined;
    }
  }

  /**
   * 关键词搜索这个人自己的全部归档（多词 = 任一命中即计 1 分，命中越多越靠前）。
   * 只搜本人分片——归档与记忆一样按 person 物理隔离。
   */
  search(personId: string, query: string, limit = 20): Array<{ day: string; role: string; text: string; score: number }> {
    const terms = String(query || '').toLowerCase().split(/[\s,，。.!！?？、]+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: Array<{ day: string; role: string; text: string; score: number }> = [];
    for (const { day } of this.listDays(personId)) {
      const doc = this.readDay(personId, day);
      if (!doc) continue;
      for (const m of doc.messages ?? []) {
        const hay = String(m.content ?? '').toLowerCase();
        if (!hay) continue;
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score += 1;
        if (score > 0) hits.push({ day, role: m.role, text: String(m.content ?? '').slice(0, 300), score });
      }
    }
    // 分数优先；同分新的日子靠前（近的更可能相关）
    return hits.sort((a, b) => b.score - a.score || (a.day < b.day ? 1 : -1)).slice(0, limit);
  }

  /** 删除超过保留期的归档目录；返回删了几个「天」 */
  purgeExpired(now = Date.now()): number {
    const cutoff = dayKey(now - this.#retention * 86_400_000);
    if (!existsSync(this.#deps.archiveDir)) return 0;
    let n = 0;
    for (const name of readdirSync(this.#deps.archiveDir)) {
      if (!isDay(name)) continue;
      if (name >= cutoff) continue; // ISO 日期串可直接字典序比较
      try {
        rmSync(join(this.#deps.archiveDir, name), { recursive: true, force: true });
        n += 1;
      } catch { /* 单天失败不拖垮整轮清理 */ }
    }
    return n;
  }
}
