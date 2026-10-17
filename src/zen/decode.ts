/**
 * 免费车道 · 三线协议流解码器（chat / responses / messages）。
 *
 * 移植自 zen-gate-server（internal/lane/stream.go）的 Decoder：
 * - 每个内容块有稳定下标（chat 的 tool_calls.index、messages / responses 的
 *   content_block.index / output_index 都映射到块下标），跨线语义一致；
 * - 工具参数按下标分槽累积，并行调用绝不串台，首片同时带 name+arguments 也不丢；
 * - DSML 控制标记清洗（含跨片扣住）；
 * - 截断判定：没有终结帧 = 流被切断；工具参数拼不成合法 JSON = 当作截断，
 *   而不是把半截参数当成功交给调用方。
 *
 * 与上游的差异只有一处：这里额外把思维链文本留下来（用于纯思考断流的续写恢复），
 * 并给出首字时间（面板要显示首字延迟）。
 */
import { DsmlScrubber, restoreToolName, type Usage } from './upstream.ts';

/** 续写恢复时最多保留多少思维链字符 */
export const CHECKPOINT_LIMIT = 131_072;

export const FINISH = {
  stop: 'stop',
  toolCalls: 'tool-calls',
  maxTokens: 'max-tokens',
  aborted: 'aborted',
} as const;
export type Finish = typeof FINISH[keyof typeof FINISH] | '';

export type BlockType = 'text' | 'reasoning' | 'tool-call';

export interface DecodeHandlers {
  /** 新开一个内容块 */
  onBlockStart?: (index: number, type: BlockType, id: string, name: string) => void;
  /** 正文增量（DSML 已清洗） */
  onText?: (index: number, delta: string) => void;
  /** 思维链增量 */
  onReasoning?: (index: number, delta: string) => void;
  /** 工具参数增量：index 与 onBlockStart 的 index 对应 */
  onToolDelta?: (index: number, id: string, name: string, delta: string) => void;
  /** 内容块结束 */
  onBlockEnd?: (index: number) => void;
}

export interface StreamResult {
  finish: Finish;
  sawFinish: boolean;
  sawText: boolean;
  sawReasoning: boolean;
  sawToolCall: boolean;
  /** 工具参数拼不成合法 JSON / 缺参数 */
  brokenToolCall: boolean;
  /** 思维链原文（截断到 CHECKPOINT_LIMIT） */
  reasoningText: string;
  checkpointTruncated: boolean;
  /** 首片（首字）到达的毫秒偏移，0 = 没收到任何内容 */
  ttftMs: number;
}

function finishReason(token: string): Finish {
  switch (token.trim().toLowerCase()) {
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return FINISH.toolCalls;
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
    case 'incomplete':
      return FINISH.maxTokens;
    default:
      return FINISH.stop;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 数值下标：上游有时给 0、有时给 0.0（JSON 数字），非整数一律 -1 */
function idxOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : -1;
}

export class StreamDecoder {
  #wire: string;
  #rename: Record<string, string>;
  #h: DecodeHandlers;
  #scrub = new DsmlScrubber();
  /** key → 块下标 */
  #blocks = new Map<string, number>();
  #next = 0;
  /** 块下标 → 已累积的工具参数 */
  #toolArgs = new Map<number, string>();
  /** messages 线：provider 的 content_block.index → key */
  #pidx = new Map<number, string>();
  /** responses 线：output_index → key */
  #oidx = new Map<number, string>();
  #result: StreamResult = {
    finish: '', sawFinish: false, sawText: false, sawReasoning: false,
    sawToolCall: false, brokenToolCall: false, reasoningText: '', checkpointTruncated: false, ttftMs: 0,
  };
  #startedAt = Date.now();

  constructor(wire: string, rename: Record<string, string>, handlers: DecodeHandlers) {
    this.#wire = wire;
    this.#rename = rename;
    this.#h = handlers;
  }

  /** 消费一帧 data 载荷 */
  decode(payload: string): void {
    // chat 线的 [DONE] 是**唯一的正常收尾**：OpenAI 系上游（含 zen-gate 自己）
    // 常常只发 [DONE] 不给 finish_reason。以前这里当垃圾跳过，结果一整轮工具调用
    // 被判成「上游断流」直接抛 transport——工具永远没机会执行。
    if (payload.trim() === '[DONE]') {
      if (!this.#result.sawFinish) this.#setFinish(FINISH.stop);
      return;
    }
    let frame: any;
    try { frame = JSON.parse(payload); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (this.#wire === 'messages') this.#decodeMessages(frame);
    else if (this.#wire === 'responses') this.#decodeResponses(frame);
    else this.#decodeChat(frame);
  }

  /** 收尾：冲掉 DSML 扣留的尾巴、校验工具参数、关掉还开着的块 */
  finish(): StreamResult {
    const rest = this.#scrub.flush();
    if (rest) {
      const idx = this.#startBlock('text', 'text', '', '');
      this.#h.onText?.(idx, rest);
      this.#result.sawText = true;
    }
    // 收尾时统一校验：任何还开着的块（chat 线工具块没有结束帧）都要验一遍
    for (const [key, idx] of [...this.#blocks]) {
      void key;
      this.#checkToolBlock(idx);
    }
    for (const key of [...this.#blocks.keys()]) this.#endBlock(key);
    if (this.#result.sawFinish && this.#result.finish === FINISH.toolCalls && this.#result.brokenToolCall) {
      this.#result.finish = FINISH.maxTokens;
    }
    return this.#result;
  }

  // ── 块与工具参数 ─────────────────────────────────────────────

  #markFirstDelta(): void {
    if (!this.#result.ttftMs) this.#result.ttftMs = Date.now() - this.#startedAt;
  }

  #startBlock(key: string, type: BlockType, id: string, name: string): number {
    const existing = this.#blocks.get(key);
    if (existing !== undefined) return existing;
    const idx = this.#next++;
    this.#blocks.set(key, idx);
    this.#h.onBlockStart?.(idx, type, id, name);
    return idx;
  }

  #endBlock(key: string): void {
    const idx = this.#blocks.get(key);
    if (idx === undefined) return;
    this.#h.onBlockEnd?.(idx);
    this.#blocks.delete(key);
  }

  #toolDelta(idx: number, id: string, name: string, delta: string): void {
    if (!delta) return;
    this.#toolArgs.set(idx, (this.#toolArgs.get(idx) ?? '') + delta);
    this.#h.onToolDelta?.(idx, id, name, delta);
  }

  /** 块结束时校验累积参数：空 / 非法 JSON 都算坏调用（整轮降级成 max-tokens） */
  #checkToolBlock(idx: number): void {
    const args = this.#toolArgs.get(idx);
    if (args === undefined) return;
    if (!args.trim()) { this.#result.brokenToolCall = true; return; }
    try { JSON.parse(args); } catch { this.#result.brokenToolCall = true; }
  }

  #text(idx: number, delta: string): void {
    if (!delta) return;
    this.#markFirstDelta();
    this.#h.onText?.(idx, this.#scrub.push(delta));
    this.#result.sawText = true;
  }

  #reasoning(idx: number, delta: string): void {
    if (!delta) return;
    this.#markFirstDelta();
    this.#h.onReasoning?.(idx, delta);
    this.#result.sawReasoning = true;
    if (this.#result.checkpointTruncated) return;
    if (this.#result.reasoningText.length + delta.length > CHECKPOINT_LIMIT) {
      this.#result.checkpointTruncated = true;
      return;
    }
    this.#result.reasoningText += delta;
  }

  #setFinish(reason: Finish): void {
    this.#result.sawFinish = true;
    this.#result.finish = reason;
  }

  // ── chat 线 ──────────────────────────────────────────────────

  #decodeChat(frame: any): void {
    if (frame.error !== undefined) return; // 由 readSSE 那一层抛成 UpstreamError
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
    if (!choice || typeof choice !== 'object') return;
    // 流式给 delta；也兼容「请求了 stream 却回了一整个 JSON」的网关
    if (choice.delta && typeof choice.delta === 'object') this.#chatDelta(choice.delta);
    if (choice.message && typeof choice.message === 'object') this.#chatDelta(choice.message);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.#setFinish(finishReason(str(choice.finish_reason)));
    }
  }

  #chatDelta(delta: any): void {
    if (typeof delta.content === 'string' && delta.content) {
      this.#text(this.#startBlock('text', 'text', '', ''), delta.content);
    }
    let reasoning = '';
    if (typeof delta.reasoning_content === 'string') reasoning = delta.reasoning_content;
    if (!reasoning && typeof delta.reasoning === 'string') reasoning = delta.reasoning;
    if (reasoning) this.#reasoning(this.#startBlock('reasoning', 'reasoning', '', ''), reasoning);

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) if (tc && typeof tc === 'object') this.#chatToolCall(tc);
    }
  }

  #chatToolCall(m: any): void {
    const fn = m.function && typeof m.function === 'object' ? m.function : undefined;
    const index = idxOf(m.index);
    let id = str(m.id) || str(fn?.id);
    let key = index >= 0 ? `tool:${index}` : '';
    if (!key) {
      // 没有 index：并行调用只能按 id 分槽；连 id 都没有的续片挂到
      // 最近打开的那个工具块上（块下标最大的那个）—— 遍历顺序是插入序，
      // 但「最大下标」这个判据与遍历顺序无关，多个块同时开着也不会串。
      if (id) key = `tool:${id}`;
      else {
        let best = '';
        let bestIdx = -1;
        for (const [k, v] of this.#blocks) {
          if (k.startsWith('tool:') && v > bestIdx) { best = k; bestIdx = v; }
        }
        if (!best) return;
        key = best;
      }
    }
    const name = str(fn?.name);
    const args = str(fn?.arguments);
    if (!id) id = `call_${Math.random().toString(16).slice(2, 10)}`;
    const displayName = restoreToolName(name, this.#rename);
    const idx = this.#startBlock(key, 'tool-call', id, displayName);
    this.#markFirstDelta();
    this.#result.sawToolCall = true;
    this.#toolDelta(idx, id, displayName, args);
  }

  // ── messages（Anthropic）线 ──────────────────────────────────

  #decodeMessages(frame: any): void {
    const type = str(frame.type);
    switch (type) {
      case 'content_block_start': {
        const idx = idxOf(frame.index);
        const cb = frame.content_block ?? {};
        const key = `p${idx}`;
        this.#pidx.set(idx, key);
        switch (str(cb.type)) {
          case 'text': this.#startBlock(key, 'text', '', ''); break;
          case 'thinking': this.#startBlock(key, 'reasoning', '', ''); break;
          case 'tool_use': {
            const id = str(cb.id) || `call_${Math.random().toString(16).slice(2, 10)}`;
            const name = restoreToolName(str(cb.name), this.#rename);
            this.#startBlock(key, 'tool-call', id, name);
            this.#result.sawToolCall = true;
            break;
          }
        }
        break;
      }
      case 'content_block_delta': {
        const key = this.#pidx.get(idxOf(frame.index));
        if (!key) return;
        const blockIdx = this.#blocks.get(key);
        if (blockIdx === undefined) return;
        const delta = frame.delta ?? {};
        switch (str(delta.type)) {
          case 'text_delta': this.#text(blockIdx, str(delta.text)); break;
          case 'thinking_delta': this.#reasoning(blockIdx, str(delta.thinking)); break;
          case 'input_json_delta': this.#toolDelta(blockIdx, '', '', str(delta.partial_json)); break;
        }
        break;
      }
      case 'content_block_stop': {
        const key = this.#pidx.get(idxOf(frame.index));
        if (!key) return;
        const blockIdx = this.#blocks.get(key);
        if (blockIdx === undefined) return;
        this.#checkToolBlock(blockIdx);
        this.#endBlock(key);
        break;
      }
      case 'message_delta': {
        const reason = str(frame.delta?.stop_reason);
        if (reason) this.#setFinish(finishReason(reason));
        break;
      }
      case 'message_stop':
        // Anthropic 先发 message_delta（带真实 stop_reason）再发 message_stop。
        // 只有没见过任何原因时才补默认值 —— 否则 max_tokens 截断会被改成"正常结束"，
        // 调用方会把半截答案当完整答案。
        if (!this.#result.sawFinish) this.#setFinish(FINISH.stop);
        break;
      default:
        break; // message_start / ping / error 由上游解析层处理
    }
  }

  // ── responses 线 ─────────────────────────────────────────────

  #decodeResponses(frame: any): void {
    const type = str(frame.type);
    const oi = idxOf(frame.output_index);
    if (type === 'response.output_item.added') {
      const item = frame.item ?? {};
      const key = `o${oi}`;
      this.#oidx.set(oi, key);
      switch (str(item.type)) {
        case 'message': this.#startBlock(key, 'text', '', ''); break;
        case 'reasoning': this.#startBlock(key, 'reasoning', '', ''); break;
        case 'function_call': {
          const id = str(item.call_id) || str(item.id) || `call_${Math.random().toString(16).slice(2, 10)}`;
          const name = restoreToolName(str(item.name), this.#rename);
          const idx = this.#startBlock(key, 'tool-call', id, name);
          this.#result.sawToolCall = true;
          // item.added 可能自带一段 arguments，不能丢
          const args = str(item.arguments);
          if (args) { this.#markFirstDelta(); this.#toolDelta(idx, id, name, args); }
          break;
        }
      }
      return;
    }
    if (type === 'response.output_text.delta') {
      const key = this.#oidx.get(oi);
      const blockIdx = key === undefined ? undefined : this.#blocks.get(key);
      if (blockIdx !== undefined) this.#text(blockIdx, str(frame.delta));
      return;
    }
    if (type.startsWith('response.reasoning') && type.endsWith('.delta')) {
      const key = this.#oidx.get(oi);
      const blockIdx = key === undefined ? undefined : this.#blocks.get(key);
      if (blockIdx !== undefined) this.#reasoning(blockIdx, str(frame.delta));
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = this.#oidx.get(oi);
      const blockIdx = key === undefined ? undefined : this.#blocks.get(key);
      if (blockIdx !== undefined) {
        this.#markFirstDelta();
        this.#toolDelta(blockIdx, '', '', str(frame.delta));
      }
      return;
    }
    if (type === 'response.output_item.done') {
      const key = this.#oidx.get(oi);
      if (key === undefined) return;
      const blockIdx = this.#blocks.get(key);
      if (blockIdx !== undefined) {
        this.#checkToolBlock(blockIdx);
        this.#endBlock(key);
      }
      this.#oidx.delete(oi);
      return;
    }
    if (type === 'response.completed' || type === 'response.done') {
      this.#setFinish(FINISH.stop);
      return;
    }
    if (type === 'response.incomplete') {
      const reason = str(frame.response?.incomplete_details?.reason);
      this.#setFinish(reason === 'max_output_tokens' ? FINISH.maxTokens : FINISH.stop);
      return;
    }
    if (type === 'response.failed') {
      // 这条线上的正常终结形状，具体错误走 usage / 上层判定
      this.#setFinish(FINISH.stop);
    }
  }
}

/** 窗口速度用：思考时间不该算进"写得多快" */
export function windowTokens(u: Usage | undefined, sawReasoning: boolean): number {
  if (!u) return 0;
  if (sawReasoning && u.reasoningTokens && u.reasoningTokens > 0) {
    return Math.max(0, u.outputTokens - u.reasoningTokens);
  }
  return u.outputTokens;
}
