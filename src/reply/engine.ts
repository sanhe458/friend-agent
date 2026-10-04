import { contextBudget, type CompressionPolicy } from '../config.ts';
import type { Inbound, Outbound, Person } from '../core/types.ts';
import type { Injection } from '../core/queue.ts';
import { compressIfNeeded } from '../context/compress.ts';
import { dayKey, type DailyContextManager, type RolloverResult } from '../context/daily.ts';
import type { MemoryStore } from '../memory/store.ts';
import { chatCompletion, chatStream, type ChatMessage } from '../models/client.ts';
import type { ModelRegistry } from '../models/registry.ts';
import type { Orchestrator } from '../orchestrator/orchestrator.ts';
import type { Persistence } from '../store/persist.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { buildMessages } from './prompt.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import type { PersonaPreset } from '../config.ts';

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_RESULT = 4000;
const HISTORY_LIMIT = 60;
const EVENT_LIMIT = 400;

const DEFAULT_POLICY: CompressionPolicy = { triggerRatio: 0.75, targetRatio: 0.5, keepRecentTurns: 8 };

/** 一轮对话里发生了什么 —— 给对话页渲染用 */
export type TurnEvent =
  | { kind: 'user'; at: number; channel: string; text: string }
  | { kind: 'assistant'; at: number; text: string }
  | { kind: 'tool'; at: number; name: string; args: string; result: string; ms: number; error?: boolean }
  | { kind: 'notice'; at: number; text: string }
  | { kind: 'error'; at: number; text: string };

export interface ReplyDeps {
  memory: MemoryStore;
  tools: ToolRegistry;
  orch: Orchestrator;
  models?: ModelRegistry;
  compression?: () => CompressionPolicy;
  /** 解析某个人该用哪套人格；不传就用内置 */
  personaFor?: (person: Person) => PersonaPreset;
  notice?: (text: string) => void;
  /** 接上就持久化历史与事件 */
  persist?: Persistence;
  /**
   * 每日上下文（三河 2026-10-04）：跨天翻篇——前一天上下文归档 + 提炼进记忆，
   * 今天从干净上下文开始。不接 = 维持旧行为（历史一直滚，快满才压缩）。
   */
  daily?: DailyContextManager;
}

function safeJson(s: string): unknown {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

/** 工具返回值序列化：循环引用 / BigInt / undefined 都不能把一轮对话炸掉 */
function safeStringify(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v) ?? ''; } catch { return String(v); }
}

/**
 * 前台回复引擎。
 * 配了 reply 角色的模型 → 真模型 + 工具循环；没配 → 退回规则桩（保证链路永远能跑）。
 *
 * 关键点：**每一次工具调用的间隙 = 一个插话注入点**（boundary）。
 */
export class ReplyEngine {
  #memory: MemoryStore;
  #tools: ToolRegistry;
  #orch: Orchestrator;
  #models?: ModelRegistry;
  #compression: () => CompressionPolicy;
  #personaFor?: (person: Person) => PersonaPreset;
  #notice: (t: string) => void;
  #persist?: Persistence;
  #daily?: DailyContextManager;
  #history = new Map<string, ChatMessage[]>();
  #events = new Map<string, TurnEvent[]>();

  constructor(deps: ReplyDeps) {
    this.#memory = deps.memory;
    this.#tools = deps.tools;
    this.#orch = deps.orch;
    this.#models = deps.models;
    this.#compression = deps.compression ?? (() => DEFAULT_POLICY);
    this.#personaFor = deps.personaFor;
    this.#notice = deps.notice ?? (() => {});
    this.#persist = deps.persist;
    this.#daily = deps.daily;
  }

  /** 历史懒加载：内存没有就从库里拉 */
  #historyOf(personId: string): ChatMessage[] {
    let h = this.#history.get(personId);
    if (!h) {
      h = this.#persist?.enabled ? this.#persist.loadHistory(personId, HISTORY_LIMIT) : [];
      this.#history.set(personId, h);
      // 恢复「当前上下文属于哪一天」：重启后靠库里最后一条消息的时间还原。
      // ⚠️ 不还原的话，「跨天 + 中途重启」的组合会让昨天的上下文悄悄活到今天——
      //    正是每日翻篇要消灭的那种污染。
      const last = this.#persist?.enabled ? this.#persist.lastHistoryAt(personId) : undefined;
      this.#daily?.markDay(personId, last != null ? dayKey(last) : dayKey(Date.now()));
    }
    return h;
  }

  /** 事件懒加载：内存没有就从库里拉 */
  #eventsOf(personId: string): TurnEvent[] {
    let e = this.#events.get(personId);
    if (!e) {
      e = this.#persist?.enabled
        ? (this.#persist.loadEvents(personId, EVENT_LIMIT) as unknown as TurnEvent[])
        : [];
      this.#events.set(personId, e);
    }
    return e;
  }

  history(personId: string): ChatMessage[] { return [...this.#historyOf(personId)]; }

  /** 这个人从头到尾的结构化事件流 */
  transcript(personId: string): TurnEvent[] { return [...this.#eventsOf(personId)]; }

  /** 外部（子 agent / 调度器）往这个人的时间线里插一条事件，让对话页也能看见 */
  note(personId: string, ev: TurnEvent): void {
    this.#eventsSet(personId, ev);
  }

  /**
   * 手动翻篇（/new 命令）：不等跨天，立刻把当前对话归档 + 提炼进记忆，干净开局。
   * 返回 undefined = 没有可归档的对话（或没接每日上下文）。
   */
  async newContext(personId: string): Promise<RolloverResult | undefined> {
    if (!this.#daily) return undefined;
    const rolled = await this.#daily.rolloverNow(personId, this.#historyOf(personId), Date.now());
    if (!rolled) return undefined;
    this.#history.set(personId, []); // 干净开局
    this.#emit(personId, {
      kind: 'notice', at: Date.now(),
      text: `手动翻篇：${rolled.messages} 条消息已归档并提炼进记忆，这里是新的开始。\n【${rolled.day} 摘要】${rolled.summary.slice(0, 400)}`,
    }, true);
    return rolled;
  }

  #eventsSet(personId: string, ev: TurnEvent): void {
    const list = this.#eventsOf(personId);
    list.push(ev);
    if (list.length > EVENT_LIMIT) list.splice(0, list.length - EVENT_LIMIT);
    this.#persist?.saveEvent(personId, ev as unknown as Record<string, unknown>);
  }

  #emit(personId: string, ev: TurnEvent, mirror: boolean): void {
    this.#eventsSet(personId, ev);
    if (mirror) this.#notice(ev.kind === 'tool' ? `调用工具 ${ev.name}` : ev.text);
  }

  async handle(
    person: Person,
    msg: Inbound,
    ctx: { drain: () => Injection[] },
    opts: { onDelta?: (fullText: string) => void } = {},
  ): Promise<Outbound> {
    const onDelta = opts.onDelta;
    const injections: string[] = [];
    const boundary = () => { for (const i of ctx.drain()) injections.push(i.text); };
    const text = (msg.text ?? '').trim();

    this.#emit(person.id, { kind: 'user', at: Date.now(), channel: msg.channel, text }, false);

    // ── 每日翻篇（三河 2026-10-04）────────────────
    // 跨天后的第一条消息：把前一天的上下文归档 + 提炼进记忆，然后从干净的历史开始。
    // 这样上下文窗口里永远只有「今天」的对话——压缩只是同一天内的应急手段，
    // 不再承担跨天记忆职责（那是记忆召回和归档查询的事），污染面小得多。
    const today = dayKey(Date.now());
    if (this.#daily) {
      const rolled = await this.#daily.rolloverIfNeeded(person.id, this.#historyOf(person.id), Date.now());
      if (rolled) {
        this.#history.set(person.id, []); // 新的一天，干净开局
        this.#emit(person.id, {
          kind: 'notice', at: Date.now(),
          text: `上下文翻篇（${rolled.day} → ${today}）：前一天 ${rolled.messages} 条消息已归档并提炼进记忆，今天从干净上下文开始。\n【${rolled.day} 摘要】${rolled.summary.slice(0, 400)}`,
        }, true);
      } else if (this.#daily.dayOf(person.id) !== today) {
        this.#daily.markDay(person.id, today);
      }
    }

    // 自动召回：不靠模型主动调，每轮先注入 top-k（配了嵌入模型走语义召回，失败自动退关键词）
    const recalled = await this.#memory.recall(person.id, text, 4);

    const hit = this.#models?.resolve('reply');
    if (!hit) return this.#ruleBased(person, msg, text, recalled, injections, boundary);

    // 工具受众过滤（三河 2026-10-02）：reply 角色只能看到没标 'sub' 的工具
    // （MCP 工具按勾选打了 audience 标；不标 = 两边都能用，原有工具行为不变）
    const toolDefs = this.#tools.list()
      .filter((t) => t.audience !== 'sub')
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));

    let messages = buildMessages({
      personName: person.displayName,
      personId: person.id,
      channel: msg.channel,
      memories: recalled,
      history: this.#historyOf(person.id),
      userText: text,
      // 人格：这个人专属 ▸ 全局默认 ▸ 内置
      persona: (this.#personaFor?.(person) ?? BUILTIN_PERSONA).prompt,
    });

    // ── 上下文压缩 ──────────────────────────────
    const policy = this.#compression();
    const budget = contextBudget(hit.model.meta, policy);

    if (budget.triggerAt > 0) {
      const r = await compressIfNeeded({
        messages,
        trigger: budget.triggerAt,
        target: budget.targetAt,
        keepRecentTurns: policy.keepRecentTurns,
        summarize: (t) => this.#summarize(hit.provider, hit.model.model, t),
      });
      if (r.compressed) {
        messages = r.messages;
        this.#emit(person.id, {
          kind: 'notice', at: Date.now(),
          text: `上下文压缩：${r.before} → ${r.after} tok（摘要掉 ${r.dropped} 条）\n${(r.summary ?? '').slice(0, 600)}`,
        }, true);
      } else if (r.before > budget.triggerAt * 0.5) {
        // ⚠️ 以前这里**每轮都无条件打一行「预算：窗口… · 触发… · 压到…」**，
        //    位置又刚好在压缩判断之前，读起来像“压缩发生了”——三河就被这行误导过。
        //    改成：真的没压且用量还低 → 什么都不发；快到线了才提醒。
        this.#emit(person.id, {
          kind: 'notice', at: Date.now(),
          text: `上下文已用 ${r.before} / 触发 ${budget.triggerAt} tok（窗口 ${budget.contextWindow}）`,
        }, false);
      }
    }

    // ── 工具循环（每个间隙都是插话点）────────────
    let reply = '';
    let visible = ''; // 已经流给用户的累计文本
    let failed = false; // 模型调用失败——失败文案不该进历史（见下方）
    const baseCall = {
      provider: hit.provider, model: hit.model.model, tools: toolDefs, maxTokens: 900,
    };
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      boundary();
      if (injections.length) {
        const extra = injections.splice(0).join('\n');
        messages.push({ role: 'user', content: `（对方又补了一句）${extra}` });
        this.#emit(person.id, { kind: 'notice', at: Date.now(), text: `插话并入上下文：${extra}` }, true);
      }

      const before = visible;
      let res;
      try {
        res = onDelta
          ? await chatStream({ ...baseCall, messages, onDelta: (t) => { visible = before + t; onDelta(visible); } })
          : await chatCompletion({ ...baseCall, messages });
      } catch (err) {
        failed = true;
        reply = `（模型调用失败：${(err as Error).message}）`;
        this.#emit(person.id, { kind: 'error', at: Date.now(), text: `模型调用失败：${(err as Error).message}` }, true);
        break;
      }

      // ⚠️ 截断的输出绝不能驱动工具调用：finish_reason=length 时工具参数 JSON
      //    可能只收到半截，safeJson 解析失败会静默回退 {}——等于拿着空参数
      //    去执行 write/schedule 这类写操作。截断一律当最终文本收场。
      if (res.truncated && res.toolCalls.length > 0) {
        reply = (res.text || '').trim() || '（生成中断，没能发起完整的操作）';
        reply += '\n（⚠ 生成中断：' + (res.truncateReason ?? '输出被截断') + '）';
        this.#emit(person.id, {
          kind: 'notice', at: Date.now(),
          text: `输出被截断（含未完整的工具调用，已放弃执行）：${res.truncateReason ?? '未知原因'}`,
        }, true);
        break;
      }

      if (res.toolCalls.length === 0) {
        reply = res.text.trim();
        // 截断（网络中断 / 达到 max_tokens）要让用户与时间线都看得见，
        // 不能把半截话当完整答案悄悄发出去
        if (res.truncated && reply) {
          reply += '\n（⚠ 生成中断：' + (res.truncateReason ?? '输出被截断') + '）';
          this.#emit(person.id, {
            kind: 'notice', at: Date.now(),
            text: `输出被截断：${res.truncateReason ?? '未知原因'}`,
          }, true);
        }
        break;
      }
      visible = before + (res.text ?? '');

      messages.push({ role: 'assistant', content: res.text || '', tool_calls: res.toolCalls });
      for (const tc of res.toolCalls) {
        const t0 = Date.now();
        let out: unknown;
        let isErr = false;
        try {
          out = await this.#tools.call(tc.function.name, safeJson(tc.function.arguments), {
            personId: person.id, channel: msg.channel, chatType: msg.chatType,
            externalId: msg.externalId,
          });
        } catch (err) {
          out = { error: (err as Error).message };
          isErr = true;
        }
        const s = typeof out === 'string' ? out : safeStringify(out);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: s.slice(0, MAX_TOOL_RESULT) });
        this.#emit(person.id, {
          kind: 'tool', at: Date.now(), name: tc.function.name,
          args: tc.function.arguments || '{}',
          result: s.slice(0, 2000),
          ms: Date.now() - t0,
          ...(isErr ? { error: true } : {}),
        }, true);
      }
    }

    // ⚠️ 工具轮次用尽（还在调工具）时，reply 仍是空的。
    //    以前直接落到“（想了一会儿，没说出来）”—— 前几轮工具白干了，用户也拿不到结论。
    //    现在再要一次**不带工具**的收尾，逼它用一两句话给结论。
    if (!reply && !failed && messages.length) {
      try {
        const r2 = await chatCompletion({
          ...baseCall, tools: undefined,
          messages: [...messages, { role: 'user', content: '（已经查得差不多了，请用一两句话直接给出结论，不要再调用工具。）' }],
        });
        reply = (r2.text || '').trim();
      } catch { /* 收尾也失败就走下面的兜底 */ }
    }
    if (!reply) reply = '（想了一会儿，没说出来）';

    // 流式漏掉的尾巴补上（工具往返后最终文本可能与已流出的不同）
    if (onDelta && reply !== visible) onDelta(reply);

    const hist = this.#historyOf(person.id);
    const userMsg: ChatMessage = { role: 'user', content: text };
    const asMsg: ChatMessage = { role: 'assistant', content: reply };
    hist.push(userMsg);
    this.#persist?.saveHistory(person.id, userMsg);
    // ⚠️ 模型调用失败时，reply 是「（模型调用失败：…）」这句提示 ——
    //    以前它会被当成助手的正式回复存进历史，然后**进入后续每一轮的上下文**，污染记忆。
    //    失败就只留用户那条，不把错误文案当回答。
    if (!failed) {
      hist.push(asMsg);
      this.#persist?.saveHistory(person.id, asMsg);
    }
    if (hist.length > HISTORY_LIMIT) hist.splice(0, hist.length - HISTORY_LIMIT);

    // 这一轮属于「今天」：跨天判定以每轮活跃日为准（下一条跨天消息会触发翻篇归档）
    this.#daily?.markDay(person.id, today);

    if (injections.length) reply += `\n（另外记下你说的：${injections.join('、')}）`;

    this.#emit(person.id, { kind: 'assistant', at: Date.now(), text: reply }, false);
    return { channel: msg.channel, to: msg.externalId, text: reply };
  }

  async #summarize(provider: unknown, model: string, text: string): Promise<string> {
    const r = await chatCompletion({
      provider: provider as never, model, maxTokens: 400, temperature: 0.3,
      messages: [
        { role: 'system', content: '把下面这段对话压成简洁摘要，保留：对方是谁、关键事实、约定、未完成的事。第三人称，不寒暄。' },
        { role: 'user', content: text },
      ],
    });
    return r.text;
  }

  /** 没配模型时的规则桩：保证链路可跑通 */
  async #ruleBased(
    person: Person,
    msg: Inbound,
    text: string,
    recalled: { text: string }[],
    injections: string[],
    boundary: () => void,
  ): Promise<Outbound> {
    const toolCtx = { personId: person.id, channel: msg.channel, chatType: msg.chatType, externalId: msg.externalId };
    const memNote = recalled.length ? recalled.map((m) => m.text).join(' / ') : '（暂无）';
    let reply: string;

    if (!text) {
      reply = '嗯？';
    } else if (/^记住/.test(text)) {
      const content = text.replace(/^记住[，,：:\s]*/, '');
      await this.#tools.call('memory_remember', { text: content, tags: ['user-said'] }, toolCtx);
      reply = `好，记住了：${content}`;
    } else if (/(浏览器|打开.*网|网页|截图)/.test(text)) {
      boundary();
      const r = (await this.#tools.call('browser', { prompt: text }, toolCtx)) as { taskId: string };
      boundary();
      reply = `行，我开浏览器看看（${r.taskId}）。`;
    } else if (/(深度搜索|深入研究|调研|查全一点)/.test(text)) {
      boundary();
      const r = (await this.#tools.call('deep_search', { prompt: text }, toolCtx)) as { taskId: string };
      boundary();
      reply = `好，我深挖一下（${r.taskId}）。`;
    } else if (/(搜|查一下|查下)/.test(text)) {
      boundary();
      const r = await this.#tools.call('search', { query: text }, toolCtx);
      boundary();
      reply = String(r);
    } else if (/(帮我|写个|做个|搞个)/.test(text)) {
      boundary();
      const r = (await this.#tools.call('delegate', { prompt: text }, toolCtx)) as { taskId: string };
      boundary();
      reply = `行，我去弄了（${r.taskId}）。`;
    } else if (/(好了没|弄好|进度|怎么样|做完)/.test(text)) {
      const tasks = this.#orch.list(person.id);
      reply = tasks.length === 0
        ? '你还没让我做啥呢。'
        : tasks.map((t) => `· [${t.kind}] ${t.prompt} → ${t.status} ${t.progress}%${t.result ? '｜' + t.result : ''}`).join('\n');
    } else {
      reply = `嗯，我听着呢。（记忆：${memNote}）`;
    }

    if (injections.length) reply += `\n〔插话并入：${injections.join('、')}〕`;
    this.#emit(person.id, { kind: 'assistant', at: Date.now(), text: reply }, false);
    return { channel: msg.channel, to: msg.externalId, text: reply };
  }
}
