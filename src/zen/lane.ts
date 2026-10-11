/**
 * OpenCode Zen 免费车道 · 车道层（Lane）。
 *
 * 在 upstream.ts 协议层之上提供：
 * - chat()：OpenAI 消息 → 免费车道对话（429 自动换模型接住，响应头标注实际服务模型）
 * - decide()：Jev 型 System One 判定模型专线（choice / score / noul）
 * - probe()：单模型体检（可用性 + 首字延迟）
 * - 限流冷却：被限流的模型进冷却池，冷却期内不再作为候选
 */
import {
  DsmlScrubber, UpstreamError, applyFingerprint, baseModelId, endpointFor,
  isSystemOneModel, postStreamed, requestIdFor, sessionForConversation,
  restoreToolName, wireFor, type Usage, type Wire,
} from './upstream.ts';
import { STATIC_CATALOG, isFreeLane, modelInfo, type ModelInfo } from './catalog.ts';

// ---------------------------------------------------------------------------
// 消息 / 工具：直接吃 OpenAI 形状，内部按线协议投影
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type?: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, any> };
}

export interface ChatResult {
  /** 实际服务这个请求的模型 id（failover 后可能与请求的不同） */
  servedBy: string;
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  usage?: Usage;
  ms: number;
}

export interface DecideResult {
  servedBy: string;
  answers: Record<string, unknown>;
  raw: Array<Record<string, any>>;
  ms: number;
}

const THROTTLE_MS = 10 * 60_000;      // 429 后的默认冷却
const REGION_BLOCK_MS = 6 * 60 * 60_000; // 地区门冷却（基本等价于不可用）

/** arguments 字符串 → 对象；空/坏串一律回 {}，上游 400 会毒化整个会话 */
function safeJson(s: string): Record<string, any> {
  if (!s || !s.trim()) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

export interface LaneOptions {
  /** 单次请求超时（默认 180s） */
  timeoutMs?: number;
  /** 429 后最多换几个模型接着试（默认 2） */
  failoverMax?: number;
  /** 默认 max_tokens（默认 4096） */
  defaultMaxTokens?: number;
}

export class ZenLane {
  #opts: Required<LaneOptions>;
  #catalog: ModelInfo[] = STATIC_CATALOG;
  #cooldown = new Map<string, number>(); // model → 冷却截止时间戳

  constructor(opts: LaneOptions = {}) {
    this.#opts = {
      timeoutMs: opts.timeoutMs ?? 180_000,
      failoverMax: opts.failoverMax ?? 2,
      defaultMaxTokens: opts.defaultMaxTokens ?? 4_096,
    };
  }

  catalog(): ModelInfo[] { return this.#catalog; }

  throttled(modelId: string): boolean { return (this.#cooldown.get(baseModelId(modelId)) ?? 0) > Date.now(); }

  #markThrottled(modelId: string, ms: number): void {
    const base = baseModelId(modelId);
    const until = Math.max(this.#cooldown.get(base) ?? 0, Date.now() + ms);
    this.#cooldown.set(base, until);
  }

  /** 候选序列：请求的模型打头，之后按目录顺序补可用模型（判定模型不参与 failover） */
  #candidates(modelId: string, max: number): string[] {
    const out = [baseModelId(modelId)];
    if (max <= 0) return out;
    for (const m of this.#catalog) {
      if (out.length > max) break;
      if (m.systemOne || m.wire === 'systemone' || out.includes(m.id)) continue;
      if (this.throttled(m.id) || !isFreeLane(m.id)) continue;
      out.push(m.id);
    }
    return out;
  }

  /** 目录缓存有效期：/v1/models 每个请求都刷新一次上游，20s 的网络等待全压在响应上 */
  #catalogAt = 0;
  #catalogTtlMs = 5 * 60_000;

  /** 拉上游实时目录；失败就沿用现有目录（静态底表兜底）。带 TTL 缓存，不会每个请求都打网络 */
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
        this.#catalog = free.map(modelInfo);
        this.#catalogAt = Date.now();
        return this.#catalog.length;
      }
    } catch { /* 目录拉不到不致命 */ }
    return this.#catalog.length;
  }

  /** 对话。System One（Jev 型）模型不接受 chat 请求，会直接抛错。 */
  async chat(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    maxTokens?: number;
    temperature?: number;
    /** 会话种子：同一下游会话应传同一个值（免费档配额按会话计） */
    sessionSeed?: string;
    /** 单轮种子：同一轮的重试共享请求 id */
    turnSeed?: string;
    signal?: AbortSignal;
  }): Promise<ChatResult> {
    if (isSystemOneModel(opts.model)) {
      throw new UpstreamError('server',
        `${baseModelId(opts.model)} 是 System One 判定模型：只答 lane.decide() 的结构化判定，不接受 chat 请求`);
    }
    let lastErr: unknown;
    for (const model of this.#candidates(opts.model, this.#opts.failoverMax)) {
      try {
        return await this.#attemptChat(model, opts);
      } catch (err) {
        lastErr = err;
        const ue = err instanceof UpstreamError ? err : undefined;
        if (!ue) throw err;
        if (ue.code === 'quota') this.#markThrottled(model, ue.retryAfter * 1000 || THROTTLE_MS);
        else if (ue.code === 'region') this.#markThrottled(model, REGION_BLOCK_MS);
        else if (ue.unavailable) this.#markThrottled(model, THROTTLE_MS);
        else throw ue; // credential / transport / aborted 换模型也没用，直接抛
      }
    }
    throw lastErr;
  }

  async #attemptChat(model: string, opts: {
    messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number;
    sessionSeed?: string; turnSeed?: string; signal?: AbortSignal;
  }): Promise<ChatResult> {
    const info = modelInfo(model);
    const wire = info.wire;
    const body = this.#buildBody(model, wire, opts);
    const rename = applyFingerprint(body, wire === 'messages' ? 'claude' : 'chat');

    const session = await sessionForConversation(opts.sessionSeed ?? 'global');
    const requestId = await requestIdFor(session, opts.turnSeed ?? '');

    const scrub = new DsmlScrubber();
    // toolSlots: 流里的 tool_call.index/content_block.index → tools 数组下标
    // toolArgsByIndex: 每个下标的参数增量累加器（index 不同绝不能混在一起）
    const state = {
      text: '', reasoning: '', sawTool: false,
      tools: [] as ChatResult['toolCalls'],
      toolSlots: new Map<number, number>(),
      toolArgsByIndex: new Map<number, string>(),
    };

    const t0 = Date.now();
    const usage = await postStreamed({
      path: endpointFor(model), body, session, requestId,
      timeoutMs: this.#opts.timeoutMs, signal: opts.signal,
      onData: (payload) => this.#decodeChatFrame(payload, wire, rename, scrub, state),
    });
    const tail = scrub.flush();
    if (tail) state.text += tail;

    return {
      servedBy: model,
      text: state.text,
      reasoning: state.reasoning,
      toolCalls: state.tools,
      usage,
      ms: Date.now() - t0,
    };
  }

  /** 按线协议组请求体（小型网关：messages/responses 线只做基础投影） */
  #buildBody(model: string, wire: Wire, opts: {
    messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number;
  }): Record<string, any> {
    const maxTokens = opts.maxTokens ?? this.#opts.defaultMaxTokens;
    const body: Record<string, any> = { model, stream: true };
    const tools = opts.tools?.length
      ? opts.tools.map((t) => ({
          type: 'function', name: t.function.name, description: t.function.description ?? '',
          parameters: t.function.parameters ?? { type: 'object', properties: {} },
        }))
      : undefined;

    if (wire === 'messages') {
      const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const msgs: any[] = [];
      for (const m of opts.messages) {
        if (m.role === 'system') continue;
        if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') {
          const blocks: any[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const c of m.tool_calls ?? []) {
            blocks.push({ type: 'tool_use', id: c.id, name: c.function.name,
              input: safeJson(c.function.arguments) });
          }
          msgs.push({ role: 'assistant', content: blocks });
        } else if (m.role === 'tool') {
          msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content }] });
        }
      }
      body.messages = msgs;
      body.max_tokens = maxTokens;
      body.anthropic_version = '2023-06-01';
      if (system) body.system = system;
      if (tools?.length) body.tools = tools;
      return body;
    }

    if (wire === 'responses') {
      const instructions = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const items: any[] = [];
      for (const m of opts.messages) {
        if (m.role === 'system') continue;
        if (m.role === 'user') items.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
        else if (m.role === 'assistant' && m.content) {
          items.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
        } else if (m.role === 'tool') {
          items.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.content });
        }
        for (const c of m.tool_calls ?? []) {
          items.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments });
        }
      }
      body.input = items;
      body.max_output_tokens = maxTokens;
      body.store = false;
      if (instructions) body.instructions = instructions;
      if (tools?.length) body.tools = tools;
      return body;
    }

    // chat 线（默认）
    const msgs: any[] = [];
    for (const m of opts.messages) {
      if (m.role === 'system') msgs.push({ role: 'system', content: m.content });
      else if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const msg: any = { role: 'assistant', content: m.content ?? '' };
        if (m.tool_calls?.length) {
          msg.tool_calls = m.tool_calls.map((c) => ({
            id: c.id, type: 'function',
            function: { name: c.function.name, arguments: c.function.arguments || '{}' },
          }));
        }
        msgs.push(msg);
      } else if (m.role === 'tool') {
        msgs.push({ role: 'tool', tool_call_id: m.tool_call_id ?? '', content: m.content });
      }
    }
    body.messages = msgs;
    body.max_tokens = maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    return body;
  }

  /**
   * 解 chat / messages / responses 三种线的一帧 SSE 载荷。
   *
   * 工具参数累积一律按 index 分槽：
   *   ⚠️ 以前用「最后一条」+ 单个 toolArgs 累加器，两个后果：
   *     ① 首片同时带 name 和部分 arguments 时（OpenAI 兼容网关很常见），
   *        那段 arguments 被 else 分支整段丢掉 → 模型发来的工具参数损坏；
   *     ② 并行多个工具调用时参数互相串台。
   */
  #decodeChatFrame(payload: string, wire: Wire, rename: Record<string, string>, scrub: DsmlScrubber,
      state: {
        text: string; reasoning: string; sawTool: boolean; tools: ChatResult['toolCalls'];
        toolSlots: Map<number, number>; toolArgsByIndex: Map<number, string>;
      }): void {
    /** 登记一个新工具调用，返回它在 tools 里的下标 */
    const openTool = (idx: number, id: string, name: string): number => {
      const pos = state.tools.push({ id, type: 'function', function: { name, arguments: '' } }) - 1;
      state.toolSlots.set(idx, pos);
      state.toolArgsByIndex.set(idx, '');
      state.sawTool = true;
      return pos;
    };
    /** 追加一段参数增量（核心修复点：绝不丢片） */
    const appendArgs = (idx: number, frag: unknown): void => {
      if (frag == null) return;
      const s = String(frag);
      if (!s) return;
      let pos = state.toolSlots.get(idx);
      if (pos === undefined) {
        // 流里省略了 index / 首帧只有 arguments：落到最后一条上（老行为）
        pos = state.tools.length - 1;
        if (pos < 0) return;
        state.toolSlots.set(idx, pos);
      }
      const acc = (state.toolArgsByIndex.get(idx) ?? '') + s;
      state.toolArgsByIndex.set(idx, acc);
      state.tools[pos].function.arguments = acc;
    };

    let frame: any;
    try { frame = JSON.parse(payload); } catch { return; }

    if (wire === 'chat') {
      const delta = frame?.choices?.[0]?.delta;
      if (delta?.content) state.text += scrub.push(String(delta.content));
      if (delta?.reasoning_content) state.reasoning += String(delta.reasoning_content);
      for (const tc of delta?.tool_calls ?? []) {
        const fn = tc?.function ?? {};
        const idx = Number.isInteger(tc?.index) ? Number(tc.index) : (state.tools.length - 1);
        if (fn.name) openTool(idx, tc.id ?? `call_${state.tools.length}`, restoreToolName(fn.name, rename));
        // ✅ 无条件追加：以前这行在 else 里，首帧带的那段参数直接被扔了
        appendArgs(idx, fn.arguments);
      }
      return;
    }

    if (wire === 'messages') {
      for (const ev of Array.isArray(frame) ? frame : [frame]) {
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') state.text += scrub.push(String(ev.delta.text ?? ''));
          if (ev.delta?.type === 'thinking_delta') state.reasoning += String(ev.delta.thinking ?? '');
          if (ev.delta?.type === 'input_json_delta') appendArgs(Number(ev.index ?? -1), ev.delta.partial_json);
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          openTool(Number(ev.index ?? -1), String(ev.content_block.id ?? `call_${state.tools.length}`), restoreToolName(String(ev.content_block.name), rename));
        }
      }
      return;
    }

    // responses 线
    if (frame?.type === 'response.output_text.delta') state.text += scrub.push(String(frame.delta ?? ''));
    if (frame?.type === 'response.reasoning_text.delta') state.reasoning += String(frame.delta ?? '');
    if (frame?.type === 'response.output_item.added' && frame.item?.type === 'function_call') {
      state.tools.push({ id: frame.item.call_id ?? frame.item.id, type: 'function',
        function: { name: restoreToolName(String(frame.item.name), rename), arguments: String(frame.item.arguments ?? '') } });
    }
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
  async probe(modelId: string): Promise<{ ok: boolean; ms: number; detail: string }> {
    const t0 = Date.now();
    try {
      if (isSystemOneModel(modelId)) {
        const r = await this.decide({
          model: modelId, state: 'probe ping',
          questions: { probe: { type: 'noul', instructions: 'Return the answer that means yes.' } },
          sessionSeed: 'probe:' + modelId,
        });
        return { ok: true, ms: Date.now() - t0, detail: `answers=${JSON.stringify(r.answers).slice(0, 120)}` };
      }
      const r = await this.chat({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 16,
        sessionSeed: 'probe:' + modelId,
        turnSeed: 'probe',
      });
      return { ok: true, ms: r.ms, detail: r.text.slice(0, 120) };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, detail: String((err as Error)?.message ?? err).slice(0, 200) };
    }
  }
}
