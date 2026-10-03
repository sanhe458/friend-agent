import type { JobRecord, Persistence } from '../store/persist.ts';

/**
 * 定时任务调度。
 *
 * 规则（spec）支持这些写法：
 *   +30m / 30m / 2h / 1d     —— 一次性，从现在起算
 *   at:2026-10-02 08:00      —— 一次性，绝对时间
 *   every:30m / every:2h     —— 每隔多久
 *   daily:08:00              —— 每天某时刻
 *   0 8 * * *                —— 五段 cron（分 时 日 月 周）
 *
 * ~ 下次触发时间（nextAt）统一由这里算好写回库，规则文本本身不存状态。
 */

const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** '30m' / '2h' / '1d' / '90s' → 毫秒 */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(String(s || '').trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * UNIT[m[2].toLowerCase()]);
}

function fmt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── cron（五段：分 时 日 月 周）─────────────────
   支持 * / a-b / a,b,c / a/n（周里 0 和 7 都算周日） */
function parseField(expr: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of String(expr).split(',')) {
    const stepM = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
    if (stepM) {
      const step = Number(stepM[2]);
      if (!step) return null;
      let lo = min, hi = max;
      if (stepM[1] !== '*') {
        const r = stepM[1].split('-').map(Number);
        lo = r[0]; hi = r[1] ?? max;
      }
      for (let i = lo; i <= hi; i += step) out.add(i);
      continue;
    }
    if (part === '*') { for (let i = min; i <= max; i++) out.add(i); continue; }
    const rangeM = /^(\d+)-(\d+)$/.exec(part);
    if (rangeM) {
      const a = Number(rangeM[1]), b = Number(rangeM[2]);
      for (let i = Math.max(a, min); i <= Math.min(b, max); i++) out.add(i);
      continue;
    }
    const n = Number(part);
    if (!Number.isInteger(n)) return null;
    out.add(n);
  }
  return out.size ? out : null;
}

interface CronFields { mi: Set<number>; ho: Set<number>; dom: Set<number> | null; mon: Set<number> | null; dow: Set<number> | null }

export function parseCron(spec: string): CronFields | undefined {
  const parts = String(spec).trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const mi = parseField(parts[0], 0, 59);
  const ho = parseField(parts[1], 0, 23);
  if (!mi || !ho) return undefined;
  const dom = parts[2] === '*' ? null : parseField(parts[2], 1, 31);
  const mon = parts[3] === '*' ? null : parseField(parts[3], 1, 12);
  const dowRaw = parts[4];
  let dow: Set<number> | null = null;
  if (dowRaw !== '*') {
    const set = parseField(dowRaw, 0, 7);
    if (!set) return undefined;
    if (set.has(7)) set.add(0); // 7 与 0 都表示周日
    dow = set;
  }
  return { mi, ho, dom, mon, dow };
}

/** 从 from 之后（不含当前分钟）找下一个匹配时刻；最多找 366 天 */
export function nextCronAt(spec: string, from: number): number | undefined {
  const f = parseCron(spec);
  if (!f) return undefined;
  const t = new Date(from + 60_000);
  t.setSeconds(0, 0);
  const limit = from + 366 * 86_400_000;
  while (t.getTime() <= limit) {
    const okTime = f.mi.has(t.getMinutes()) && f.ho.has(t.getHours());
    const okDom = !f.dom || f.dom.has(t.getDate());
    const okMon = !f.mon || f.mon.has(t.getMonth() + 1);
    const okDow = !f.dow || f.dow.has(t.getDay());
    // 日/周同时限定时，按 cron 惯例取“或”
    const dayOk = f.dom && f.dow ? (okDom || okDow) : (okDom && okDow);
    if (okTime && okMon && dayOk) return t.getTime();
    t.setMinutes(t.getMinutes() + 1);
  }
  return undefined;
}

/**
 * 算下一次触发时间。
 * @param lastRunAt 已跑过的话传上一次时间——一次性规则会返回 undefined（不再重排）。
 */
export function nextRunAt(spec: string, from = Date.now(), opts: { lastRunAt?: number } = {}): number | undefined {
  const s = String(spec || '').trim();
  if (!s) return undefined;
  const ran = opts.lastRunAt != null;

  // 一次性：相对 / 绝对
  if (s.startsWith('at:')) {
    if (ran) return undefined;
    const raw = s.slice(3).trim().replace('T', ' ');
    const t = new Date(raw.replace(/-/g, '/')).getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  const dur = parseDuration(s.replace(/^\+/, ''));
  if (dur && !/^(every|daily):/i.test(s)) {
    if (ran) return undefined;
    return from + dur;
  }

  // 循环间隔
  const ev = /^every:(.+)$/i.exec(s);
  if (ev) {
    const d = parseDuration(ev[1].trim());
    if (!d) return undefined;
    const base = opts.lastRunAt ?? from;
    return base + d;
  }

  // 每天某时刻
  const dy = /^daily:(\d{1,2}):(\d{2})$/i.exec(s);
  if (dy) {
    const h = Number(dy[1]), mi = Number(dy[2]);
    if (h > 23 || mi > 59) return undefined;
    const d = new Date(from);
    d.setHours(h, mi, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // 五段 cron
  return nextCronAt(s, from);
}

/** 把规则文本说成人话（面板上显示用） */
export function describeSpec(spec: string): string {
  const s = String(spec || '').trim();
  const dy = /^daily:(\d{1,2}):(\d{2})$/i.exec(s);
  if (dy) return `每天 ${dy[1].padStart(2, '0')}:${dy[2]}`;
  const ev = /^every:(.+)$/i.exec(s);
  if (ev) return `每 ${ev[1]}`;
  if (s.startsWith('at:')) return `一次 · ${s.slice(3)}`;
  if (parseDuration(s.replace(/^\+/, '')) && !parseCron(s)) return `一次 · ${s.replace(/^\+/, '')} 后`;
  if (parseCron(s)) return `cron ${s}`;
  return s;
}

export interface SchedulerDeps {
  persist: Persistence;
  /** 触发时执行；返回一句结果描述（会写进 lastResult） */
  onFire: (job: JobRecord) => Promise<string | void>;
  log: (s: string) => void;
  /**
   * 触发链路里**兜底之外**的异常（如投递失败）。
   * 不接的话，`#fire` 之后的异步链路一旦抛错就是 unhandled rejection。
   */
  onError?: (job: JobRecord, err: Error) => void;
  /** 检查间隔，默认 15s */
  intervalMs?: number;
}

export class Scheduler {
  #deps: SchedulerDeps;
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;
  /** 正在跑的任务 id：长任务不应该被下一次 tick 叠加触发 */
  #running = new Set<string>();

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  list(): JobRecord[] {
    return this.#deps.persist.loadJobs();
  }

  get(id: string): JobRecord | undefined {
    return this.list().find((j) => j.id === id);
  }

  add(input: {
    spec: string; text: string; channel: string; to: string;
    title?: string; kind?: 'say' | 'ask'; personId?: string; at?: number;
  }): JobRecord {
    const spec = String(input.spec || '').trim();
    const nextAt = nextRunAt(spec);
    if (!nextAt) throw new Error(`无法解析时间规则「${spec}」——可用 +30m / every:2h / daily:08:00 / "0 8 * * *"`);
    const job: JobRecord = {
      id: 'j_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3),
      title: String(input.title || input.text || spec).slice(0, 40),
      spec,
      kind: input.kind === 'ask' ? 'ask' : 'say',
      text: String(input.text ?? ''),
      channel: input.channel,
      to: input.to,
      ...(input.personId ? { personId: input.personId } : {}),
      enabled: true,
      createdAt: Date.now(),
      nextAt,
      runs: 0,
    };
    this.#deps.persist.saveJob(job);
    this.#deps.log(`[定时] 已创建 ${job.id}「${job.title}」${describeSpec(spec)} → ${fmt(nextAt)}`);
    return job;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.#deps.persist.deleteJob(id);
    this.#deps.log(`[定时] 已删除 ${id}`);
    return true;
  }

  setEnabled(id: string, on: boolean): JobRecord | undefined {
    const j = this.get(id);
    if (!j) return undefined;
    j.enabled = on;
    if (on) j.nextAt = nextRunAt(j.spec) ?? j.nextAt;
    this.#deps.persist.saveJob(j);
    return j;
  }

  /** 立刻跑一次（不影响原本的下次时间） */
  async runNow(id: string): Promise<string> {
    const j = this.get(id);
    if (!j) throw new Error('任务不存在');
    if (this.#running.has(id)) throw new Error('上一轮还在跑，请等它结束');
    this.#running.add(id);
    try {
      return await this.#fire(j, true);
    } finally {
      this.#running.delete(id);
    }
  }
  start(): void {
    if (this.#timer) return;
    const ms = this.#deps.intervalMs ?? 15_000;
    this.#timer = setInterval(() => { void this.tick(); }, ms);
    this.#deps.log(`[定时] 调度器已启动，每 ${Math.round(ms / 1000)}s 检查一次；共 ${this.list().length} 个任务`);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 到点也补跑（进程重启后错过的任务会在下一跳被执行） */
  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const now = Date.now();
      for (const j of this.list()) {
        if (!j.enabled || j.nextAt > now) continue;
        if (this.#running.has(j.id)) continue; // 上一轮还在跑（长任务），不要叠着再开一轮
        this.#running.add(j.id);
        // ⚠️ 以前是 `await this.#fire(...)` —— **串行等待**。
        //    ask 类任务的 onFire 要走一整轮模型对话（几十秒到几分钟），这期间
        //    **其他到点的定时任务全部被卡住**。改成发出去就不等，只靠 #running 防重叠。
        void this.#fire(j, false)
          .catch((err) => this.#deps.onError?.(j, err as Error))
          .finally(() => this.#running.delete(j.id));
      }
    } catch (err) {
      this.#deps.log(`[定时] 检查出错：${(err as Error).message}`);
    } finally {
      this.#busy = false;
    }
  }

  async #fire(job: JobRecord, manual: boolean): Promise<string> {
    let result: string;
    this.#deps.log(`[定时] 触发 ${job.id}「${job.title}」${manual ? '（手动）' : ''}`);
    try {
      const r = await this.#deps.onFire(job);
      result = typeof r === 'string' && r ? r : '已执行';
    } catch (err) {
      result = '失败：' + (err as Error).message;
      this.#deps.log(`[定时] ${job.id} 执行失败：${(err as Error).message}`);
    }
    const next = { ...job, lastRunAt: Date.now(), runs: job.runs + 1, lastResult: result.slice(0, 200) };
    if (!manual) {
      // ⚠️ 手动触发不改排期（runNow 的注释承诺）：否则 every:2h 手动跑一次会把
      //    下次触发推迟 2 小时；未到点的一次性任务更会被这里直接禁用。
      const nxt = nextRunAt(job.spec, Date.now(), { lastRunAt: Date.now() });
      if (nxt) {
        next.nextAt = nxt;
      } else {
        next.enabled = false; // 一次性任务跑完即停
        next.nextAt = Number.MAX_SAFE_INTEGER;
      }
    }
    // ⚠️ 任务在跑的过程中可能被用户删了——onFire（ask 类要跑几分钟）结束后
    //    再 upsert 会把已删除的任务**复活**。先查还在不在，不在就别写回。
    if (!this.get(job.id)) {
      this.#deps.log(`[定时] ${job.id} 已在执行期间被删除，不再回写`);
      return result;
    }
    // ⚠️ 回写失败（磁盘写不进去）不该把整条链路炸掉
    try {
      this.#deps.persist.saveJob(next);
    } catch (err) {
      this.#deps.onError?.(job, err as Error);
    }
    return result;
  }
}
