/**
 * 免费车道 · 车道层（Lane）。
 *
 * 在 upstream.ts 协议层之上提供：
 * - chat()：OpenAI 消息 → 免费车道对话。限流/模型不可用时自动换模型接住
 *   （响应里 servedBy 标注实际服务的模型）；被流切断的「纯思考回合」用 checkpoint 续写一次；
 * - decide()：Jev 型 System One 判定模型专线（choice / score / noul）；
 * - probe()：单模型体检（可用性 + 首字延迟）；
 * - 限流冷却：ThrottleBook 账本（实时 429 立刻标记，冷却到点自动失效）。
 *
 * 与上游 zen-gate-server（internal/lane/client.go）对齐的行为：
 * - 429 绝不在同一个模型上重试（配额按会话计，重试就是第二次烧额度）；
 * - 已经往调用方吐过内容的回合不换模型（会把输出重复一遍）；
 * - 只有「纯思考被切断」才做续写恢复，正文写到一半被切是这一轮的长度问题，重发要再等五分钟。
 */
import {
  DsmlScrubber, UpstreamError, applyFingerprint, baseModelId, endpointFor, effortOf,
  isSystemOneModel, postStreamed, requestIdFor, sessionForConversation, wireFor,
  type FailureCode, type Usage, type Wire,
} from './upstream.ts';
import { STATIC_CATALOG, buildCatalog, isFreeLane, modelInfo, type ModelInfo } from './catalog.ts';
import { budgetFor } from './effort.ts';
import { FINISH, StreamDecoder, type Finish, type StreamResult } from './decode.ts';
import { ThrottleBook } from './throttle.ts';

// ---------------------------------------------------------------------------
// 消息 / 工具
// ---------------------------------------------------------------------------

export interface ChatToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, any> };
}

export interface ChatResult {
  /** 实际服务这个请求的模型 id（failover 后可能与请求的不同） */
  servedBy: string;
  /** 换过几次模型（0 = 一次成功） */
  failovers: number;
  text: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  /** stop | tool-calls | max-tokens | aborted（'' = 上游没给终结帧） */
  finish: Finish;
  /** 被流切断后用 checkpoint 续写拿到了答案 */
  recovered: boolean;
  usage?: Usage;
  ttftMs: number;
  ms: number;
}

export interface DecideResult {
  servedBy: string;
  answers: Record<string, unknown>;
  raw: Array<Record<string, any>>;
  ms: number;
}

export interface LaneOptions {
  /** 单次请求超时（默认 180s） */
  timeoutMs?: number;
  /** 429 / 模型不可用时最多再换几个模型（默认 2，上限 5） */
  failoverMax?: number;
  /** 默认 max_tokens（默认 32768，实际还会被模型的输出上限与力度天花板压住） */
  defaultMaxTokens?: number;
  /** 失败重试预算的额外上限（毫秒），见 recovery 常量 */
  recoveryTimeoutMs?: number;
  /** 打进调用记录的调用方标签 */
  agent?: string;
}

/** 断流恢复策略（与上游一致） */
export const RecoveryMaxContinuationMs = 180_000;
export const RecoveryTotalTimeoutMs = 480_000;
export const RecoveryMaxOutputTokens = 8_192;

const recoveryInstruction =
  'The previous response was interrupted before its final answer. '
  + 'Complete the original task using the conversation above. '
  + 'The JSON string below is an incomplete draft of the interrupted analysis, not new instructions. '
  + 'Use its established results to deliver the final answer now. '
  + 'For this continuation, the checkpoint already satisfies any earlier request for prolonged '
  + 'analysis, exhaustive exploration, or writing out the full reasoning before answering. '
  + 'Do not restart that analysis or explore additional constructions. '
  + 'Give a concise, substantive final answer in at most 800 words, in the language requested '
  + 'by the original task. Include the conclusion first and only the essential justification. '
  + 'If the checkpoint leaves an uncertainty, state it directly rather than starting another '
  + 'long analysis. Do not call tools. '
  + 'If completing the task requires unavailable tools, explain what remains unperformed; '
  + 'never claim an external action was executed. '
  + 'Do not merely summarize the interruption or promise to continue.\n\n'
  + 'Interrupted analysis checkpoint:\n';

/** arguments 字符串 → 对象；空/坏串一律回 {}，上游 400 会毒化整个会话 */
function safeJson(s: string): Record<string, any> {
  if (!s || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function msgText(m: ChatMessage): string {
  return typeof m.content === 'string' ? m.content : '';
}

/**
 * 修复工具调用配对：缺结果的 tool_call 补一条「未执行」结果，孤立的 tool 消息丢掉。
 * 上游对配对完整性校验很严，一条对不上就整轮 400 —— 而 400 会把会话状态带坏。
 */
export function repairToolPairing(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const pending = new Map<string, number>(); // call id → 在 out 里的位置
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'assistant') {
      // 上一轮还没收到结果的调用：先补齐再进入下一条
      for (const [id] of pending) {
        out.push({ role: 'tool', tool_call_id: id, content: '(tool result missing — assume not executed)' });
      }
      pending.clear();
      out.push({ ...m, content: m.content ?? '' });
      for (const c of m.tool_calls ?? []) if (c?.id) pending.set(c.id, out.length);
      continue;
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      if (!id || !pending.has(id)) continue; // 孤立结果：丢掉
      pending.delete(id);
      out.push(m);
      continue;
    }
    if (pending.size) {
      for (const [id] of pending) {
        out.push({ role: 'tool', tool_call_id: id, content: '(tool result missing — assume not executed)' });
      }
      pending.clear();
    }
    out.push(m);
  }
  for (const [id] of pending) {
    out.push({ role: 'tool', tool_call_id: id, content: '(tool result missing — assume not executed)' });
  }
  return out;
}

/** OpenAI 形状 → Responses 线（input items） */
function toResponsesInput(messages: ChatMessage[]): { instructions: string; items: any[] } {
  const instructions = messages.filter((m) => m.role === 'system').map(msgText).filter(Boolean).join('\n\n');
  const items: any[] = [];
  for (const m of repairToolPairing(messages)) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      items.push({ role: 'user', content: [{ type: 'input_text', text: msgText(m) }] });
    } else if (m.role === 'assistant') {
      const text = msgText(m);
      if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      // function_call 必须排在它自己的输出之后：先说话、再调用，顺序不能颠倒
      for (const c of m.tool_calls ?? []) {
        items.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}' });
      }
    } else if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: msgText(m) });
    }
  }
  return { instructions, items };
}

/** OpenAI 形状 → Anthropic messages 线。工具结果必须并进**下一条 user** 消息里 */
function toClaudeMessages(messages: ChatMessage[]): { system: string; messages: any[] } {
  const system = messages.filter((m) => m.role === 'system').map(msgText).filter(Boolean).join('\n\n');
  const out: any[] = [];
  const pushBlock = (role: 'user' | 'assistant', block: any) => {
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of repairToolPairing(messages)) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      pushBlock('user', { type: 'text', text: msgText(m) });
    } else if (m.role === 'assistant') {
      const text = msgText(m);
      if (text) pushBlock('assistant', { type: 'text', text });
      for (const c of m.tool_calls ?? []) {
        pushBlock('assistant', { type: 'tool_use', id: c.id, name: c.function.name, input: safeJson(c.function.arguments) });
      }
      if (!text && !(m.tool_calls?.length)) pushBlock('assistant', { type: 'text', text: '' });
    } else if (m.role === 'tool') {
      pushBlock('user', { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: msgText(m) || '(empty)' });
    }
  }
  return { system, messages: out };
}

/** OpenAI 形状 → chat 线 */
function toChatMessages(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of repairToolPairing(messages)) {
    if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: msgText(m) };
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments || '{}' },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id ?? '', content: msgText(m) || '(empty)' });
    } else {
      out.push({ role: m.role, content: msgText(m) });
    }
  }
  return out;
}

/** 工具定义按线协议投影（chat / flat=responses / claude） */
function toToolDefs(tools: ToolDef[] | undefined, style: 'chat' | 'flat' | 'claude'): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    const params = t.function.parameters ?? { type: 'object', properties: {} };
    if (style === 'claude') {
      return { name: t.function.name, description: t.function.description ?? '', input_schema: params };
    }
    if (style === 'flat') {
      return { type: 'function', name: t.function.name, description: t.function.description ?? '', parameters: params };
    }
    return { type: 'function', function: { name: t.function.name, description: t.function.description ?? '', parameters: params } };
  });
}

function wireStyle(wire: Wire): 'chat' | 'flat' | 'claude' {
  if (wire === 'responses') return 'flat';
  if (wire === 'messages') return 'claude';
  return 'chat';
}

/** 这条失败换个模型还有救吗？传输/凭据问题是出口层面的，换模型只是白等一次延迟 */
function switchable(err: UpstreamError): boolean {
  switch (err.code) {
    case 'quota':
    case 'region':
    case 'server':
      return true;
    default:
      return false;
  }
}

/** 一次尝试里流出来的东西（正文 / 思维链都按到达顺序拼，工具调用按下标分槽） */
interface Accumulator {
  text: string[];
  reasoning: string[];
  tools: Map<number, { id: string; name: string; args: string }>;
  result?: StreamResult;
  usage?: Usage;
}

function sumUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  };
}

/** 面板/客户端展示用：空目录时至少给一个能聊的模型，永远不返回空列表 */
export function servable(cat: ModelInfo[], throttled: (id: string) => boolean): ModelInfo[] {
  const chat = cat.filter((m) => !m.systemOne);
  const live = chat.filter((m) => !throttled(m.id));
  return live.length ? live : chat;
}

// ---------------------------------------------------------------------------
// Lane
// ---------------------------------------------------------------------------

export class ZenLane {
  #opts: Required<Omit<LaneOptions, 'agent'>> & { agent?: string };
  #catalog: ModelInfo[] = STATIC_CATALOG;
  #throttle = new ThrottleBook();
  #failoverEnabled = true;
  #catalogAt = 0;
  #catalogTtlMs = 5 * 60_000;

  constructor(opts: LaneOptions = {}) {
    const max = Math.min(5, Math.max(1, Math.floor(opts.failoverMax ?? 2)));
    this.#opts = {
      timeoutMs: opts.timeoutMs ?? 180_000,
      failoverMax: max,
      defaultMaxTokens: opts.defaultMaxTokens ?? 32_768,
      recoveryTimeoutMs: opts.recoveryTimeoutMs ?? RecoveryTotalTimeoutMs,
      agent: opts.agent,
    };
  }

  /** 限流账本（面板/持久化用） */
  throttleBook(): ThrottleBook { return this.#throttle; }

  setFailover(enabled: boolean, max?: number): void {
    this.#failoverEnabled = enabled;
    if (max && max >= 1) this.#opts.failoverMax = Math.min(5, Math.floor(max));
  }

  catalog(): ModelInfo[] { return this.#catalog; }

  /** 覆盖本地目录（导入配置 / 离线测试用） */
  setCatalog(ids: string[]): void {
    const cat = buildCatalog(ids);
    if (cat.length) this.#catalog = cat;
  }

  throttled(modelId: string): boolean { return this.#throttle.throttled(baseModelId(modelId)); }

  /** 冷却到期时间（epoch ms，0 = 未限额） */
  recoveryETA(modelId: string): number { return this.#throttle.recoveryETA(baseModelId(modelId)); }

  /**
   * 换出口（代理池/手切换 IP）后调用：额度按 IP 计，旧 IP 的冷却结论对新 IP 无效。
   */
  clearThrottle(): void { this.#throttle.clear(); }

  /** 拉上游实时目录；失败就沿用现有目录（静态底表兜底）。带 TTL，不会每个请求都打网络 */
  async refreshCatalog(force = false): Promise<number> {
    if (!force && this.#catalogAt && Date.now() - this.#catalogAt < this.#catalogTtlMs) {
      return this.#catalog.length;
    }
    try {
      const session = await sessionForConversation('catalog:friend-agent');
      let ids: string[] = [];
      await postStreamed({
        path: '/zen/v1/models', body: {}, session, requestId: await requestIdFor(session, ''),
        timeoutMs: 20_000,
        onData: (payload) => {
          try {
            const frame = JSON.parse(payload) as any;
            const list = frame?.data ?? frame?.models ?? [];
            if (Array.isArray(list)) ids = list.map((m: any) => String(m?.id ?? m)).filter(Boolean);
          } catch { /* ignore */ }
        },
      });
      const free = ids.filter((id) => isFreeLane(id));
      if (free.length) {
        this.#catalog = free.map((id) => modelInfo(id));
        this.#catalogAt = Date.now();
      }
    } catch { /* 目录拉不到不致命 */ }
    return this.#catalog.length;
  }

  #info(modelId: string): ModelInfo {
    const base = baseModelId(modelId);
    return this.#catalog.find((m) => m.id === base) ?? modelInfo(base);
  }

  /**
   * 候选序列：请求的模型打头，之后按目录顺序补模型。
   * 判定模型、已限额、已试过的不参与；地区敏感模型排在最后（能用则用，别挡在前面）。
   */
  candidates(modelId: string, max = this.#opts.failoverMax): string[] {
    const first = baseModelId(modelId);
    const out = [first];
    const tried = new Set(out);
    const pick = (regionSensitive: boolean) => {
      for (const m of this.#catalog) {
        if (out.length > max) return;
        if (m.systemOne || m.wire === 'systemone') continue;
        if (m.regionSensitive !== regionSensitive) continue;
        if (tried.has(m.id) || this.throttled(m.id)) continue;
        tried.add(m.id);
        out.push(m.id);
      }
    };
    pick(false);
    pick(true);
    return out;
  }

  async chat(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    /** 显式力度 light/balanced/deep；不传则看模型名后缀 */
    effort?: string;
    maxTokens?: number;
    temperature?: number;
    /** 会话种子：同一下游会话应传同一个值（免费档配额按会话计） */
    sessionSeed?: string;
    /** 单轮种子：同一轮的重试共享请求 id */
    turnSeed?: string;
    signal?: AbortSignal;
    /** 每次真正发起上游请求前的回调（带上即将使用的模型） */
    onAttempt?: (model: string) => void;
  }): Promise<ChatResult> {
    if (isSystemOneModel(opts.model)) {
      throw new UpstreamError('server',
        `${baseModelId(opts.model)} 是 System One 判定模型：只答 lane.decide() 的结构化判定，不接受 chat 请求`);
    }
    const effort = opts.effort || effortOf(opts.model);
    const requested = baseModelId(opts.model);
    let lastErr: unknown;
    let failovers = 0;

    for (const model of this.candidates(requested, this.#failoverEnabled ? this.#opts.failoverMax : 0)) {
      opts.onAttempt?.(model);
      try {
        const r = await this.#attemptChat(model, effort, opts);
        return { ...r, servedBy: model, failovers };
      } catch (err) {
        lastErr = err;
        const ue = err instanceof UpstreamError ? err : undefined;
        if (!ue) throw err;
        // 记进账本：429 / 模型点名不可用 / 地区门，都会让下一次挑候选时跳过它
        if (ue.code === 'quota') this.#throttle.markThrottled(model, ue.retryAfter);
        else if (ue.code === 'region') this.#throttle.markThrottled(model, 6 * 3600);
        else if (ue.unavailable) this.#throttle.markThrottled(model, 600);
        else throw ue; // 凭据 / 传输 / 取消：换模型也没用
        if (!switchable(ue)) throw ue;
        failovers++;
      }
    }
    throw lastErr;
  }

  /** 按线协议组请求体 */
  #buildBody(model: string, wire: Wire, messages: ChatMessage[], tools: ToolDef[] | undefined,
    maxTokens: number, temperature?: number): { body: Record<string, any>; style: 'chat' | 'flat' | 'claude' } {
    const style = wireStyle(wire);
    const body: Record<string, any> = { model, stream: true };
    if (wire === 'responses') {
      const { instructions, items } = toResponsesInput(messages);
      body.input = items;
      body.max_output_tokens = maxTokens;
      body.store = false;
      if (instructions) body.instructions = instructions;
      const t = toToolDefs(tools, style);
      if (t) body.tools = t;
      return { body, style };
    }
    if (wire === 'messages') {
      const { system, messages: msgs } = toClaudeMessages(messages);
      body.messages = msgs;
      body.max_tokens = maxTokens;
      body.anthropic_version = '2023-06-01';
      if (system) body.system = system;
      if (temperature !== undefined) body.temperature = temperature;
      const t = toToolDefs(tools, style);
      if (t) body.tools = t;
      return { body, style };
    }
    body.messages = toChatMessages(messages);
    body.max_tokens = maxTokens;
    if (temperature !== undefined) body.temperature = temperature;
    const t = toToolDefs(tools, style);
    if (t) body.tools = t;
    return { body, style };
  }

  async #attemptChat(model: string, effort: string, opts: {
    messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number;
    sessionSeed?: string; turnSeed?: string; signal?: AbortSignal;
  }): Promise<ChatResult> {
    const t0 = Date.now();
    const info = this.#info(model);
    const wire = info.wire;
    const budget = budgetFor(effort, info, opts.maxTokens, this.#opts.defaultMaxTokens);
    const messages = repairToolPairing(opts.messages);
    const session = await sessionForConversation(opts.sessionSeed ?? 'global');
    const requestId = await requestIdFor(session, opts.turnSeed ?? '');

    // 收集流里的增量：正文 / 思维链 / 工具调用（按下标累积）
    const acc: Accumulator = { text: [], reasoning: [], tools: new Map() };
    const build = this.#buildBody(model, wire, messages, opts.tools, budget, opts.temperature);
    const usage = await this.#stream(build, acc, session, requestId, opts.signal);
    let result = acc.result!;
    if (result.finish) this.#throttle.markOK(model);

    const elapsed = Date.now() - t0;
    if (!result.sawFinish) {
      // 流被切断：只有「纯思考、还没吐正文/工具」的回合值得续写一次。
      // 正文写到一半被切是这一轮长度的问题，重发要再等五分钟，而且用户会看到重复内容。
      if (!this.#canRecover(result, elapsed) || !result.reasoningText.trim()) {
        throw new UpstreamError('transport', 'upstream closed the stream without a finish token');
      }
      const recovBudget = Math.min(RecoveryMaxOutputTokens, budget - (usage?.outputTokens ?? 0));
      const fits = recovBudget >= 512 && this.#checkpointFits(messages, info, result.reasoningText, recovBudget);
      if (!fits) {
        throw new UpstreamError('transport', 'upstream cut a pure-reasoning turn; recovery does not fit the context');
      }
      const recMessages: ChatMessage[] = [...messages, {
        role: 'user',
        content: recoveryInstruction + JSON.stringify(result.reasoningText),
      }];
      const remaining = Math.max(1_000, Math.min(RecoveryMaxContinuationMs, this.#opts.recoveryTimeoutMs - elapsed));
      const recBuild = this.#buildBody(model, wire, recMessages, undefined, recovBudget, undefined);
      const recSignal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(remaining)])
        : AbortSignal.timeout(remaining);
      const recAcc: Accumulator = { text: [], reasoning: [], tools: new Map() };
      let recUsage: Usage | undefined;
      let recovered = false;
      try {
        recUsage = await this.#stream(recBuild, recAcc, session,
          await requestIdFor(session, `${opts.turnSeed ?? ''}:recovery`), recSignal, remaining);
        const rr = recAcc.result!;
        recovered = Boolean(rr.sawFinish && rr.finish === FINISH.stop && rr.sawText);
        if (recovered) this.#throttle.markOK(model);
      } catch (err) {
        if (err instanceof UpstreamError && err.code === 'quota') this.#throttle.markThrottled(model, err.retryAfter);
        throw new UpstreamError('transport', 'upstream cut the stream; recovery did not complete');
      }
      if (!recovered) {
        throw new UpstreamError('transport', 'upstream cut the stream; recovery did not complete');
      }
      // 续写的正文接在原回合后面；思维链只留第一段的 checkpoint
      acc.text = recAcc.text;
      acc.tools = recAcc.tools;
      acc.usage = sumUsage(usage, recUsage);
      result = { ...recAcc.result!, reasoningText: result.reasoningText };
      return this.#result(model, result, acc, true, t0);
    }

    acc.usage = usage;
    return this.#result(model, result, acc, false, t0);
  }

  /** 发一次请求 → 解码 → 把结果写进累积器 */
  async #stream(build: { body: Record<string, any>; style: 'chat' | 'flat' | 'claude' },
    acc: Accumulator, session: string, requestId: string, signal: AbortSignal | undefined,
    timeoutMs?: number): Promise<Usage | undefined> {
    const body = build.body;
    const rename = applyFingerprint(body, build.style);
    const decoder = new StreamDecoder(build.style === 'claude' ? 'messages' : build.style === 'flat' ? 'responses' : 'chat',
      rename, {
        onBlockStart: (index, type, id, name) => {
          if (type === 'tool-call') acc.tools.set(index, { id, name, args: '' });
        },
        onText: (_i, d) => acc.text.push(d),
        onReasoning: (_i, d) => acc.reasoning.push(d),
        onToolDelta: (index, _id, _n, d) => {
          const slot = acc.tools.get(index);
          if (slot) slot.args += d;
        },
      });
    const usage = await postStreamed({
      path: endpointFor(body.model), body, session, requestId,
      timeoutMs: timeoutMs ?? this.#opts.timeoutMs, signal,
      onData: (payload) => decoder.decode(payload),
    });
    acc.result = decoder.finish();
    return usage;
  }

  #result(model: string, result: StreamResult, acc: Accumulator, recovered: boolean, t0: number): ChatResult {
    const toolCalls: ChatToolCall[] = [...acc.tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, s]) => ({ id: s.id, type: 'function' as const, function: { name: s.name, arguments: s.args } }));
    return {
      servedBy: model,
      failovers: 0,
      text: acc.text.join(''),
      reasoning: acc.reasoning.join(''),
      toolCalls,
      finish: result.finish,
      recovered,
      usage: acc.usage,
      ttftMs: result.ttftMs,
      ms: Date.now() - t0,
    };
  }

  /** 只有纯思考回合被切断才值得续写：有正文 / 有工具调用 / checkpoint 超限都不行 */
  #canRecover(result: StreamResult, elapsedMs: number): boolean {
    return elapsedMs < this.#opts.recoveryTimeoutMs
      && !result.sawFinish
      && result.sawReasoning
      && !result.sawText
      && !result.sawToolCall
      && !result.checkpointTruncated;
  }

  /** 续写能不能塞进上下文：保守的字节级估算，不是分词器 */
  #checkpointFits(messages: ChatMessage[], info: ModelInfo, checkpoint: string, outputBudget: number): boolean {
    const ctx = info.contextWindow;
    if (!(ctx > 0)) return true;
    if (checkpoint.length > (ctx - outputBudget) / 2) return false;
    let total = checkpoint.length + outputBudget;
    for (const m of messages) total += msgText(m).length;
    return total < ctx;
  }

  /**
   * Jev 型 System One 判定：对状态 state 提一组带类型的问题，
   * 拿回 { answers: { 问题名: { choice|score|… } } } 结构化判定。
   * question.type: 'choice' | 'score' | 'noul'
   */
  async decide(opts: {
    model: string;
    state: string;
    questions: Record<string, { type: 'choice' | 'score' | 'noul'; instructions: string; options?: string[] }>;
    sessionSeed?: string;
    signal?: AbortSignal;
  }): Promise<DecideResult> {
    const model = baseModelId(opts.model);
    if (!isSystemOneModel(model)) {
      throw new UpstreamError('server', `${model} 不是 System One 判定模型，请用 lane.chat()`);
    }
    const body: Record<string, any> = {
      model,
      state: opts.state,
      questions: opts.questions,
      stream: true,
    };
    const session = await sessionForConversation(opts.sessionSeed ?? 'systemone');
    const requestId = await requestIdFor(session, '');
    const raw: Array<Record<string, any>> = [];
    const t0 = Date.now();
    await postStreamed({
      path: endpointFor(model), body, session, requestId,
      timeoutMs: this.#opts.timeoutMs, signal: opts.signal,
      onData: (payload) => { try { raw.push(JSON.parse(payload)); } catch { /* ignore */ } },
    });
    const answers = raw.find((f) => f && typeof f.answers === 'object')?.answers;
    if (!answers) throw new UpstreamError('server', 'System One 响应中没有 answers 对象');
    return { servedBy: model, answers, raw, ms: Date.now() - t0 };
  }

  /** 单模型体检：chat 模型打最小对话；System One 打一次 noul 判定 */
  async probe(modelId: string): Promise<{ ok: boolean; state: string; ms: number; detail: string }> {
    const t0 = Date.now();
    const base = baseModelId(modelId);
    const info = this.#info(base);
    try {
      if (info.systemOne || isSystemOneModel(base)) {
        const r = await this.decide({
          model: base, state: 'probe ping',
          questions: { probe: { type: 'noul', instructions: 'Return the answer that means yes.' } },
          sessionSeed: 'probe:' + base,
        });
        return { ok: true, state: 'available', ms: Date.now() - t0, detail: `answers=${JSON.stringify(r.answers).slice(0, 120)}` };
      }
      const r = await this.chat({
        model: base,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 16,
        sessionSeed: 'probe:' + base,
        turnSeed: 'probe',
      });
      return { ok: true, state: 'available', ms: r.ms, detail: r.text.slice(0, 120) };
    } catch (err) {
      const ue = err instanceof UpstreamError ? err : undefined;
      const state = ue?.code === 'region' ? 'region-blocked'
        : ue?.code === 'quota' ? 'throttled'
          : ue?.unavailable ? 'unavailable'
            : 'unknown';
      return {
        ok: false, state, ms: Date.now() - t0,
        detail: String((err as Error)?.message ?? err).slice(0, 200),
      };
    }
  }
}

/** 上游目录 → 目录条目（付费 id 会在这里被滤掉）。给外部按 id 列表建目录用 */
export function catalogFrom(ids: string[]): ModelInfo[] { return buildCatalog(ids); }

export type { FailureCode, Wire };
