import type { Provider } from '../config.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role=tool 时对应哪次调用 */
  tool_call_id?: string;
  /** assistant 发起工具调用 */
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ChatResult {
  text: string;
  ms: number;
  toolCalls: ToolCall[];
  usage?: unknown;
  /** 是否因为端点不支持 tools 而降级重试过 */
  toolsDropped?: boolean;
  /**
   * 流式中途断了、只拿到半截就返回。
   * ⚠️ 以前这种情况**什么都不说**，上层会把截断的答案当完整答案发出去。
   */
  truncated?: boolean;
  /** 截断原因（给日志/面板用） */
  truncateReason?: string;
}

/** baseUrl 可以是 https://x/v1，也可以直接给到 /chat/completions */
export function chatEndpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

async function once(opts: {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<ChatResult> {
  const { provider, model, messages } = opts;
  if (!provider.apiKey) throw new Error(`提供商 ${provider.id} 没有配置 key`);

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.8,
    stream: false,
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }

  const t0 = Date.now();
  const res = await fetch(chatEndpoint(provider.baseUrl), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + provider.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  const ms = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: ToolCall[] } }>;
    usage?: unknown;
  };
  const msg = data.choices?.[0]?.message;
  const content = msg?.content;
  return {
    text: typeof content === 'string' ? content : (content == null ? '' : JSON.stringify(content)),
    ms,
    toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls : [],
    usage: data.usage,
  };
}

/**
 * 端点是不是明确“不接受 tools”。
 * 只有这种情况才该去掉工具重试——超时/429/5xx 不算（那只会让本来就吃力的端点再挨一下）。
 */
function looksLikeToolsUnsupported(err: unknown): boolean {
  const m = String((err as Error)?.message ?? '').toLowerCase();
  return /tool|function_?call|tool_choice|unsupported|not support|does not support/.test(m);
}

/** 带 tools 的调用；**只在端点明确不支持 tools 时**才降级重试一次 */
export async function chatCompletion(opts: {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<ChatResult> {
  try {
    return await once(opts);
  } catch (err) {
    // ⚠️ 以前是「带 tools 就无脑降级重试」：超时 / 429 / 5xx 也会走到这里，
    //    于是**在端点已经不行的时候再打一次**，而且悄悄把工具拿掉（上层只看到 toolsDropped）。
    //    现在只认「明确不支持 tools」这一种。
    if (opts.tools?.length && looksLikeToolsUnsupported(err)) {
      const r = await once({ ...opts, tools: undefined });
      return { ...r, toolsDropped: true };
    }
    throw err;
  }
}

/**
 * 流式调用（SSE）。onDelta 每次拿到的是**累计全文**，不是增量。
 * 端点不支持流式时自动回退到非流式，并一次性把全文吐给 onDelta。
 */
export async function chatStream(opts: {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  onDelta: (fullText: string) => void;
}): Promise<ChatResult> {
  const { provider, model, messages } = opts;
  if (!provider.apiKey) throw new Error(`提供商 ${provider.id} 没有配置 key`);

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.8,
    stream: true,
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(chatEndpoint(provider.baseUrl), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + provider.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
  } catch (err) {
    return fallbackStream(opts, err as Error);
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    return fallbackStream(opts, new Error(`HTTP ${res.status}：${detail.slice(0, 200)}`));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage: unknown;
  const calls = new Map<number, ToolCall>();

  const consume = (payload: string) => {
    if (!payload || payload === '[DONE]') return;
    let rec: any;
    try { rec = JSON.parse(payload); } catch { return; }
    if (rec.usage) usage = rec.usage;
    const d = rec.choices?.[0]?.delta;
    if (!d) return;
    if (typeof d.content === 'string' && d.content) {
      text += d.content;
      opts.onDelta(text);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = Number(tc?.index ?? 0);
        const cur = calls.get(idx) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
        if (tc?.id) cur.id = String(tc.id);
        if (tc?.function?.name) cur.function.name = String(tc.function.name);
        if (tc?.function?.arguments) cur.function.arguments += String(tc.function.arguments);
        calls.set(idx, cur);
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.replace(/\r$/, '');
        if (!s.startsWith('data:')) continue;
        consume(s.slice(5).trim());
      }
    }
  } catch (err) {
    // 一个字节都没收到：退回非流式（那边会再试一次）
    if (!text) return fallbackStream(opts, err as Error);
    // ⚠️ 已经收到部分文本：**不能装作答案完整**。标记出来，让上层自己决定怎么处置。
    return {
      text,
      ms: Date.now() - t0,
      toolCalls: [],
      usage,
      truncated: true,
      truncateReason: (err as Error)?.message ?? String(err),
    };
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((c) => c.function.name);

  return { text, ms: Date.now() - t0, toolCalls, usage };
}

/** 流式不可用时：整段拿到再一次性吐 */
async function fallbackStream(
  opts: Parameters<typeof chatStream>[0],
  cause: Error,
): Promise<ChatResult> {
  const r = await once({
    provider: opts.provider,
    model: opts.model,
    messages: opts.messages,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (r.text) opts.onDelta(r.text);
  console.error('[chatStream] 回退非流式：', cause.message);
  return r;
}
