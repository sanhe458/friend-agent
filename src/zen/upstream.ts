/**
 * OpenCode Zen 免费车道 · 上游协议层。
 *
 * 协议行为移植自 zen-gate-server（Go，MIT 参考实现 dsh-our-free-model），
 * 只保留小型网关需要的部分：会话铸造、指纹门（tools 四元组）、
 * 三种线协议路由、SystemOne（Jev 判定模型）专线、DSML 控制标记清洗。
 * 免费车道使用仍受上游服务条款约束。
 */

export const UPSTREAM_BASE = 'https://opencode.ai';

/** 网关对 User-Agent 有下限校验（>= 1.17） */
export const CLIENT_UA = 'opencode/1.18.31';

/** 免费档指纹门要求的 tools 四元组（小写） */
export const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read'] as const;

/** 线协议：chat | responses | messages | systemone */
export type Wire = 'chat' | 'responses' | 'messages' | 'systemone';

export type FailureCode = 'quota' | 'region' | 'credential' | 'server' | 'transport' | 'aborted';

export class UpstreamError extends Error {
  code: FailureCode;
  retryAfter: number;
  unavailable: boolean;
  constructor(code: FailureCode, message: string, opts: { retryAfter?: number; unavailable?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryAfter = opts.retryAfter ?? 0;
    this.unavailable = opts.unavailable ?? false;
  }
}

// ---------------------------------------------------------------------------
// 会话 / 请求 id 铸造
// ---------------------------------------------------------------------------

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62From(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

function randomBase62(n: number): string {
  const raw = new Uint8Array(n);
  crypto.getRandomValues(raw);
  return base62From(raw);
}

let lastStamp = 0;
let seqCounter = 0;

/** 铸造网关形状的会话 id（时间前缀 + 单调计数，与上游参考实现逐字节一致） */
export function mintSessionId(nowMS = Date.now()): string {
  if (lastStamp !== nowMS) {
    lastStamp = nowMS;
    seqCounter = 0;
  }
  const seq = ++seqCounter;
  const value = ~((BigInt(nowMS) << 12n) | BigInt(seq & 0xfff));
  const raw = new Uint8Array(6);
  for (let i = 0; i < 6; i++) raw[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  return 'ses_' + hex(raw) + randomBase62(14);
}

/** 铸造单轮请求 id */
export function mintRequestId(nowMS = Date.now()): string {
  const value = ~((BigInt(nowMS) << 12n) | 1n);
  const raw = new Uint8Array(6);
  for (let i = 0; i < 6; i++) raw[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  return 'msg_' + hex(raw) + randomBase62(14);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/**
 * 一条下游会话 → 一个稳定上游会话。免费档配额按会话计，
 * 每次换新 id 会立刻把配额打爆（表现为 429）。
 */
export async function sessionForConversation(seed: string): Promise<string> {
  seed = seed.trim();
  if (SESSION_RE.test(seed)) return seed;
  if (!seed) seed = 'global';
  const sum = await sha256('our-free-model\x00' + seed);
  return 'ses_' + hex(sum.slice(0, 6)) + base62From(sum.slice(6, 20));
}

/** 稳定的单轮请求 id；同一轮的重试共享它 */
export async function requestIdFor(session: string, turnSeed: string): Promise<string> {
  if (!turnSeed.trim()) return mintRequestId();
  const sum = await sha256('our-free-model-req\x00' + session + '\x00' + turnSeed);
  const id = 'msg_' + hex(sum.slice(0, 6)) + base62From(sum.slice(6, 20));
  return REQUEST_RE.test(id) ? id : mintRequestId();
}

// ---------------------------------------------------------------------------
// 模型 id / 线协议路由
// ---------------------------------------------------------------------------

const MUSE_RE = /^muse[-_]?spark(?:$|[-_:.\s])/i;
const SYSTEM_ONE_RE = /^jev/;

/** 剥掉尾部 "(light|balanced|deep)" effort 后缀 */
export function baseModelId(model: string): string {
  const s = model.trim();
  if (s.length > 1 && s.endsWith(')')) {
    const i = s.lastIndexOf('(');
    if (i > 0) return s.slice(0, i).trim();
  }
  return s;
}

export function effortOf(model: string): '' | 'light' | 'balanced' | 'deep' {
  const s = model.trim();
  if (s.length > 1 && s.endsWith(')')) {
    const i = s.lastIndexOf('(');
    if (i > 0) {
      const inner = s.slice(i + 1, -1).trim().toLowerCase();
      if (inner === 'light' || inner === 'balanced' || inner === 'deep') return inner;
    }
  }
  return '';
}

/**
 * Jev 型 "System One" 判定模型不做文本生成：它在自己的端点上对带类型的问题
 * 回答结构化判定，绝不能拿去当 chat 模型。
 */
export function isSystemOneModel(modelId: string): boolean {
  return SYSTEM_ONE_RE.test(baseModelId(modelId));
}

export function wireFor(modelId: string): Wire {
  const base = baseModelId(modelId);
  if (isSystemOneModel(base)) return 'systemone';
  if (MUSE_RE.test(base)) return 'responses';
  if (base === 'union-alpha') return 'messages';
  return 'chat';
}

export function endpointFor(modelId: string): string {
  switch (wireFor(modelId)) {
    case 'responses': return '/zen/v1/responses';
    case 'messages': return '/zen/v1/messages';
    case 'systemone': return '/zen/v1/systemone';
    default: return '/zen/v1/chat/completions';
  }
}

/** 网关靠这组头指纹识别真实桌面客户端；"Bearer public" 是共享免费凭据 */
export function gatewayHeaders(session: string, requestId: string, accept = '*/*'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'authorization': 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'desktop',
    'x-opencode-session': session,
    'x-opencode-request': requestId,
    'x-opencode-project': 'global',
    'accept': accept,
  };
}

// ---------------------------------------------------------------------------
// 指纹门：tools 必须声明四元组，缺的槽位补自禁用占位工具
// ---------------------------------------------------------------------------

type Tool = Record<string, any>;

function toolNameOf(tool: Tool): string {
  if (typeof tool?.name === 'string' && tool.name.trim()) return tool.name.trim();
  const fn = tool?.function;
  if (typeof fn?.name === 'string' && fn.name.trim()) return fn.name.trim();
  return '';
}

function cloneTool(tool: Tool, name: string): Tool {
  const fn = tool?.function;
  if (fn && typeof fn === 'object') {
    return { type: tool.type, function: { ...fn, name } };
  }
  return { ...tool, name };
}

/** 缺槽位时能顶上的真实工具名（pwsh → bash） */
const QUARTET_DONORS: Record<string, string[]> = { bash: ['pwsh'] };

/**
 * 满足免费档指纹门：body.tools 必须声明全部四个小写四元组名。
 * 调用方已有的槽位原样保留（必要时就地改名）；缺的槽位先找能顶替的
 * 真实工具（pwsh → bash），实在没有才补「自禁用」占位工具。
 * 返回 发送拼写 → 调用方拼写 的还原表。body 原地修改。
 */
export function applyFingerprint(body: Record<string, any>, style: 'chat' | 'flat' | 'claude' = 'chat'): Record<string, string> {
  const rename: Record<string, string> = {};
  const tools: Tool[] = Array.isArray(body.tools) ? body.tools.filter((t: unknown) => t && typeof t === 'object') : [];
  const hadClientTools = tools.length > 0;

  const seen = new Set<string>();
  const out: Tool[] = [];
  for (const tool of tools) {
    const current = toolNameOf(tool);
    const lower = current.toLowerCase();
    const key = (FINGERPRINT_TOOLS as readonly string[]).includes(lower) ? lower : '';
    if (!key) { out.push(tool); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    if (current !== key) {
      rename[key] = current;
      out.push(cloneTool(tool, key));
    } else {
      out.push(tool);
    }
  }

  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue;
    // 先找 donor：一个非四元组的真实工具顶上去
    const donors = QUARTET_DONORS[name] ?? [];
    const idx = out.findIndex((t) => {
      const orig = toolNameOf(t);
      if (!orig) return false;
      const lower = orig.toLowerCase();
      // 只允许「非四元组」的真实工具顶上去（已是四元组槽位的不能挪用）
      return !(FINGERPRINT_TOOLS as readonly string[]).includes(lower) && donors.includes(lower);
    });
    if (idx >= 0) {
      const tool = out[idx];
      const orig = toolNameOf(tool);
      rename[name] = orig;
      out[idx] = cloneTool(tool, name);
      seen.add(name);
      continue;
    }
    // 没有 donor → 自禁用占位
    const desc = 'This tool is currently unavailable and must not be used.';
    if (style === 'claude') {
      out.push({ name, description: desc, input_schema: { type: 'object', properties: {} } });
    } else if (style === 'flat') {
      out.push({ type: 'function', name, description: desc, parameters: { type: 'object', properties: {} } });
    } else {
      out.push({ type: 'function', function: { name, description: desc, parameters: { type: 'object', properties: {} } } });
    }
  }

  body.tools = out;
  if (!('tool_choice' in body)) {
    if (style === 'flat') body.tool_choice = 'auto';
    else if (!hadClientTools) body.tool_choice = style === 'claude' ? { type: 'none' } : 'none';
  }
  return rename;
}

export function restoreToolName(name: string, rename: Record<string, string>): string {
  return rename[name] ?? name;
}

// ---------------------------------------------------------------------------
// DSML 控制标记清洗
// ---------------------------------------------------------------------------

const DSML_OPENING = '<｜DSML｜';
const DSML_TAG = /<｜DSML｜[^>]*>/g;

/**
 * DeepSeek v4 系偶尔把内部 DSML 控制标记当文本漏出来
 * （字面 "<｜DSML｜ calls>"，紧跟一次合法 tool call）。流式清洗：
 * 疑似开头的尾部先扣住，等下一片到了再判；整片标记直接删。
 */
export class DsmlScrubber {
  #held = '';

  push(delta: string): string {
    let text = this.#held + delta;
    this.#held = '';
    const idx = text.lastIndexOf(DSML_OPENING);
    if (idx >= 0 && !text.slice(idx).includes('>')) {
      // 完整开头但 '>' 还没到 → 整段扣住
      this.#held = text.slice(idx);
      text = text.slice(0, idx);
    } else if (idx < 0) {
      // 尾部疑似是开头的前缀 → 扣住等下一片
      for (let len = Math.min(DSML_OPENING.length - 1, text.length); len > 0; len--) {
        if (text.endsWith(DSML_OPENING.slice(0, len))) {
          this.#held = text.slice(-len);
          text = text.slice(0, -len);
          break;
        }
      }
    }
    return text.replace(DSML_TAG, '');
  }

  flush(): string {
    const out = this.#held;
    this.#held = '';
    return out.replace(DSML_TAG, '');
  }
}

// ---------------------------------------------------------------------------
// 上游 POST + SSE 解码
// ---------------------------------------------------------------------------

const REGION_RE = /RegionError|not available in your country|region.?block/i;
const QUOTA_RE = /FreeUsageLimitError|usage limit|rate limit/i;
const MODEL_ERR_RE = /ModelError|model is unavailable|model is not supported|not supported|Endpoint is unavailable/i;

function classifyFailure(status: number, payload: string, retryAfterSec: number): UpstreamError {
  const message = payload.slice(0, 300);
  if (REGION_RE.test(payload)) return new UpstreamError('region', message);
  if (status === 429 || QUOTA_RE.test(payload)) {
    return new UpstreamError('quota', message, { retryAfter: retryAfterSec || 60 });
  }
  if (status === 401 || status === 403) return new UpstreamError('credential', message);
  if (status >= 500) return new UpstreamError('server', message);
  if (status === 404 || status === 400 || status === 422 || MODEL_ERR_RE.test(payload)) {
    return new UpstreamError('server', message, { unavailable: true });
  }
  return new UpstreamError('server', message);
}

export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number }

/**
 * 发一个流式请求，把每条 `data:` 载荷交给 onData。
 * 内容型网关有时用 application/json 头回 SSE：按首片形状嗅探，兼容两种。
 */
export async function postStreamed(opts: {
  path: string;
  body: Record<string, any>;
  session: string;
  requestId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData: (payload: string) => void;
}): Promise<Usage | undefined> {
  const res = await fetch(UPSTREAM_BASE + opts.path, {
    method: 'POST',
    headers: gatewayHeaders(opts.session, opts.requestId, 'text/event-stream'),
    body: JSON.stringify(opts.body),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 180_000),
  }).catch((err: Error) => {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new UpstreamError('aborted', 'cancelled');
    throw new UpstreamError('transport', err.message);
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw classifyFailure(res.status, text, Number(res.headers.get('retry-after') ?? 0));
  }

  const reader = (res.body ?? throwErr(new UpstreamError('transport', 'empty body'))).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage: Usage | undefined;

  const feed = (payload: string) => {
    opts.onData(payload);
    if (!usage) {
      try {
        const frame = JSON.parse(payload) as any;
        const u = frame?.response?.usage ?? frame?.usage ?? frame?.message?.usage;
        if (u) {
          usage = {
            inputTokens: Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0),
            totalTokens: Number(u.total_tokens ?? u.totalTokens ?? 0),
          };
        }
      } catch { /* ignore */ }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 按行切；不完整就留到下一片
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data: ')) feed(line.slice(6));
    }
  }
  if (buf.startsWith('data: ')) feed(buf.slice(6));
  return usage;
}

function throwErr(e: Error): never { throw e; }
