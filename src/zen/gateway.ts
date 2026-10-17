/**
 * OpenCode Zen 计划代理网关 · HTTP 层。
 *
 * 把免费车道封装成标准接口，任何支持自定义 base_url 的 Agent/客户端都能直接接：
 *
 *   GET  /healthz                 存活探针
 *   GET  /v1/models               模型目录（含 jev-* 判定模型，标注 system_one）
 *   GET  /v1/budget               力度阶梯与本次会真正发出去的 max_tokens
 *   POST /v1/chat/completions     OpenAI Chat Completions
 *   POST /v1/messages             Anthropic Messages（Claude Code 一类客户端）
 *   POST /v1/responses            OpenAI Responses
 *   POST /v1/systemone            Jev 型 System One 判定专线（choice / score / noul）
 *   POST /v1/probe                单模型体检
 *
 * 统一约定（与 zen-gate-server 一致）：
 * - 响应头 x-zen-gate-served-by：实际服务这一轮的模型（failover 后可能不是请求的那个）；
 * - 限流/模型不可用的错误体里带 suggestions，客户端可以立刻改模型重试；
 * - 流式输出里思维链用 reasoning_content，与缓冲区里的字段名保持一致（客户端按这个名字取）。
 *
 * 配了 apiKey 时，/v1/* 需要 Authorization: Bearer <key>（Anthropic 客户端也认 x-api-key）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { UpstreamError, baseModelId, isSystemOneModel, type Usage } from './upstream.ts';
import { ZenLane, type ChatMessage, type ToolDef } from './lane.ts';
import { budgetLadder } from './effort.ts';
import { modelInfo } from './catalog.ts';

export interface ZenGateOptions {
  host?: string;
  port?: number;
  /** 访问 /v1/* 需要的 API Key；为空则不校验（仅建议回环地址这么干） */
  apiKey?: string;
  lane?: ZenLane;
  /** 单次请求体上限（字节），默认 64MB —— 长上下文对话很容易超过 8MB */
  bodyLimit?: number;
}

const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, limit: number): Promise<any> =>
  new Promise((resolve) => {
    let buf = '';
    let done = false;
    let bytes = 0;
    const finish = (v: any) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c: Buffer) => {
      if (done) return;
      bytes += c.length;
      if (bytes > limit) {
        // 超限直接断开，别把内存吃光
        try { req.destroy(); } catch { /* ignore */ }
        finish({});
        return;
      }
      buf += c.toString();
    });
    req.on('end', () => {
      try {
        // JSON.parse('null') 得到 null：以前直接往下传，路由里读 body.model 就 500
        const v = buf ? JSON.parse(buf) : {};
        finish(v && typeof v === 'object' ? v : {});
      } catch { finish({}); }
    });
    req.on('error', () => finish({}));
    req.on('close', () => finish({}));
  });

/** 上游错误 → 客户端响应（保留语义：429 限流 / 403 地区门 / 401 凭据 / 5xx 上游故障） */
function statusOf(err: UpstreamError): number {
  switch (err.code) {
    case 'quota': return 429;
    case 'region': return 403;
    case 'credential': return 401;
    case 'aborted': return 504;
    default: return 502;
  }
}

function errorTypeOf(err: UpstreamError): string {
  switch (err.code) {
    case 'quota': return 'rate_limit_error';
    case 'region': return 'permission_error';
    case 'credential': return 'authentication_error';
    case 'aborted': return 'timeout_error';
    default: return 'upstream_error';
  }
}

/** Anthropic 口径的 SSE 写出器 */
function anthropicSse(res: ServerResponse) {
  let started = false;
  const ensureHead = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  };
  return {
    get started() { return started; },
    event(payload: unknown) {
      ensureHead();
      const type = (payload as any)?.type ?? 'message';
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    end() { if (started) res.end(); },
    noteManaged: ensureHead,
  };
}

/** OpenAI 口径的 SSE 写出器 */
function openaiSse(res: ServerResponse) {
  let started = false;
  const ensureHead = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  };
  return {
    get started() { return started; },
    chunk(payload: unknown) {
      ensureHead();
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    done() {
      ensureHead();
      res.write('data: [DONE]\n\n');
      res.end();
    },
  };
}

function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function usageOfOpenAI(u: Usage | undefined) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.totalTokens || u.inputTokens + u.outputTokens,
  };
}

/**
 * 把一轮结果按 OpenAI Chat Completions 的形状吐出去。
 * 注意：role 帧要等第一次真正产出内容时才写 —— 一旦写了响应头，
 * x-zen-gate-served-by 就再也改不了，而那一轮可能正在 failover。
 */
function writeOpenAIChat(res: ServerResponse, stream: boolean,
  run: (signal: AbortSignal) => Promise<{ text: string; reasoning: string; toolCalls: any[]; usage?: Usage; finish: string; servedBy: string; recovered: boolean }>,
  requested: string) {
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on('close', onClose);
  const id = randomId('chatcmpl-zen-');
  const sse = openaiSse(res);
  void (async () => {
    try {
      const r = await run(ac.signal);
      if (!stream) {
        json(res, 200, {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: r.servedBy,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: r.text,
              ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
              ...(r.toolCalls.length ? { tool_calls: r.toolCalls } : {}),
            },
            finish_reason: r.toolCalls.length ? 'tool_calls' : r.finish === 'max-tokens' ? 'length' : 'stop',
          }],
          usage: usageOfOpenAI(r.usage),
          'x_zen_gate': { served_by: r.servedBy, recovered: r.recovered },
        }, { 'x-zen-gate-served-by': r.servedBy });
        return;
      }
      res.setHeader('x-zen-gate-served-by', r.servedBy);
      sse.chunk({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r.servedBy,
        choices: [{ index: 0, delta: { role: 'assistant', content: r.text }, finish_reason: null }],
      });
      // 思维链单独一帧，字段名用 reasoning_content（与缓冲区一致）
      if (r.reasoning) {
        sse.chunk({
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r.servedBy,
          choices: [{ index: 0, delta: { reasoning_content: r.reasoning }, finish_reason: null }],
        });
      }
      for (const [i, c] of r.toolCalls.entries()) {
        sse.chunk({
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r.servedBy,
          choices: [{ index: 0, delta: { tool_calls: [{ index: i, ...c }] }, finish_reason: null }],
        });
      }
      sse.chunk({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r.servedBy,
        choices: [{
          index: 0, delta: {},
          finish_reason: r.toolCalls.length ? 'tool_calls' : r.finish === 'max-tokens' ? 'length' : 'stop',
        }],
        usage: usageOfOpenAI(r.usage),
      });
      sse.done();
    } catch (err) {
      const ue = err instanceof UpstreamError ? err
        : new UpstreamError('server', String((err as Error)?.message ?? err));
      if (sse.started) {
        sse.chunk({ error: { message: ue.message, type: errorTypeOf(ue), code: ue.code } });
        res.end();
        return;
      }
      sendError(res, ue);
    } finally {
      res.off('close', onClose);
    }
  })();
}

function sendError(res: ServerResponse, err: UpstreamError, withSuggestions: string[] = []) {
  const status = statusOf(err);
  const headers: Record<string, string> = {};
  if (err.retryAfter) headers['retry-after'] = String(err.retryAfter);
  const body: Record<string, any> = {
    error: {
      message: err.message,
      type: errorTypeOf(err),
      code: err.code,
      ...(err.unavailable ? { unavailable: true } : {}),
      ...(withSuggestions.length ? { suggestions: withSuggestions } : {}),
    },
  };
  json(res, status, body, headers);
}

export function createZenGate(opts: ZenGateOptions = {}): { server: Server; lane: ZenLane } {
  const lane = opts.lane ?? new ZenLane();
  const limit = opts.bodyLimit ?? 64 * 1024 * 1024;

  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (url === '/healthz') return json(res, 200, { ok: true });

      // /v1/* 统一做 Key 护栏：兼容 OpenAI 的 Authorization 和 Anthropic 的 x-api-key
      if (url.startsWith('/v1/') && opts.apiKey) {
        const auth = String(req.headers.authorization ?? '');
        const alt = String(req.headers['x-api-key'] ?? '');
        if (auth !== `Bearer ${opts.apiKey}` && alt !== opts.apiKey) {
          return json(res, 401, {
            error: { message: '无效的 API Key', type: 'authentication_error', code: 'INVALID_CREDENTIAL' },
          });
        }
      }

      if (url === '/v1/models' && req.method === 'GET') {
        void lane.refreshCatalog(); // 后台刷新，别把 20s 的网络等待压在客户端响应上
        return json(res, 200, {
          object: 'list',
          data: lane.catalog().map((m) => ({
            id: m.id, object: 'model', owned_by: 'opencode-zen',
            wire: m.wire, system_one: m.systemOne,
            context_window: m.contextWindow, max_output: m.maxOutput,
            vision: m.vision, reasoning: m.reasoning, can_disable_thinking: m.canDisableThinking,
            region_sensitive: m.regionSensitive,
            throttled: lane.throttled(m.id),
            recovery_eta: lane.recoveryETA(m.id) || undefined,
            blurb: m.blurb,
          })),
        });
      }

      if (url === '/v1/budget' && (req.method === 'GET' || req.method === 'POST')) {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        const body = req.method === 'POST' ? await readBody(req, 1 << 20) : {};
        const model = baseModelId(String(body?.model ?? q.get('model') ?? 'mimo-v2.6-flash-free'));
        const reqTokens = Number(body?.max_tokens ?? q.get('max_tokens') ?? 0) || undefined;
        const info = lane.catalog().find((m) => m.id === model) ?? modelInfo(model);
        return json(res, 200, {
          model: info.id, wire: info.wire, context_window: info.contextWindow,
          max_output: info.maxOutput, can_disable_thinking: info.canDisableThinking,
          levels: budgetLadder(info, reqTokens),
        });
      }

      if (url === '/v1/chat/completions' && req.method === 'POST') {
        const body = await readBody(req, limit);
        if (!Array.isArray(body?.messages) || !body.messages.length) {
          return json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request_error' } });
        }
        const requested = String(body.model ?? '');
        if (isSystemOneModel(requested)) {
          return json(res, 400, {
            error: {
              message: `${requested} 是 System One 判定模型：请改用 POST /v1/systemone，或换 chat 模型`,
              type: 'invalid_request_error',
            },
          });
        }
        // ⚠️ 以前是 `signal: req.destroyed ? undefined : undefined` —— 永远 undefined，
        //    客户端断开后上游请求还在跑到底，白烧配额。现在用 AbortController 接 res 的 close。
        writeOpenAIChat(res, Boolean(body.stream), (signal) => lane.chat({
          model: requested,
          messages: body.messages as ChatMessage[],
          tools: body.tools as ToolDef[] | undefined,
          effort: String(body.reasoning_effort ?? ''),
          maxTokens: body.max_tokens ?? body.max_completion_tokens,
          temperature: body.temperature,
          sessionSeed: String(body.user ?? body.session_seed ?? 'global'),
          turnSeed: body.turn_seed,
          signal,
        }), requested);
        return;
      }

      if (url === '/v1/messages' && req.method === 'POST') {
        const body = await readBody(req, limit);
        if (!Array.isArray(body?.messages) || !body.messages.length) {
          return json(res, 400, { error: { type: 'invalid_request_error', message: 'messages 不能为空' } });
        }
        const requested = String(body.model ?? '');
        const messages = fromAnthropicMessages(body);
        const tools = fromAnthropicTools(body.tools);
        const ac = new AbortController();
        const onClose = () => ac.abort();
        res.on('close', onClose);
        const sse = anthropicSse(res);
        let model = requested;
        const msgId = randomId('msg_');
        const start = () => {
          if (sse.started) return;
          res.setHeader('x-zen-gate-served-by', model);
          sse.noteManaged();
          sse.event({
            type: 'message_start',
            message: {
              id: msgId, type: 'message', role: 'assistant', model,
              content: [], stop_sequence: null, stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });
        };
        try {
          const r = await lane.chat({
            model: requested,
            messages,
            tools,
            effort: String(body.effort ?? ''),
            maxTokens: body.max_tokens,
            temperature: body.temperature,
            sessionSeed: String(body.metadata?.user_id ?? body.session_seed ?? 'global'),
            turnSeed: body.turn_seed,
            signal: ac.signal,
            onAttempt: (m) => { model = m; },
          });
          model = r.servedBy;
          if (!body.stream) {
            return json(res, 200, {
              id: msgId, type: 'message', role: 'assistant', model: r.servedBy,
              content: [
                ...(r.reasoning ? [{ type: 'thinking', thinking: r.reasoning }] : []),
                ...(r.text ? [{ type: 'text', text: r.text }] : []),
                ...r.toolCalls.map((c) => ({
                  type: 'tool_use', id: c.id, name: c.function.name,
                  input: safeJson(c.function.arguments),
                })),
              ],
              stop_reason: r.toolCalls.length ? 'tool_use' : r.finish === 'max-tokens' ? 'max_tokens' : 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: r.usage?.inputTokens ?? 0,
                output_tokens: r.usage?.outputTokens ?? 0,
              },
            }, { 'x-zen-gate-served-by': r.servedBy });
          }
          start();
          if (r.reasoning) {
            sse.event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
            sse.event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: r.reasoning } });
            sse.event({ type: 'content_block_stop', index: 0 });
          }
          const textIdx = r.reasoning ? 1 : 0;
          if (r.text) {
            sse.event({ type: 'content_block_start', index: textIdx, content_block: { type: 'text', text: '' } });
            sse.event({ type: 'content_block_delta', index: textIdx, delta: { type: 'text_delta', text: r.text } });
            sse.event({ type: 'content_block_stop', index: textIdx });
          }
          let i = textIdx + (r.text ? 1 : 0);
          for (const c of r.toolCalls) {
            sse.event({
              type: 'content_block_start', index: i,
              content_block: { type: 'tool_use', id: c.id, name: c.function.name, input: {} },
            });
            sse.event({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: c.function.arguments || '{}' } });
            sse.event({ type: 'content_block_stop', index: i });
            i++;
          }
          sse.event({
            type: 'message_delta',
            delta: { stop_reason: r.toolCalls.length ? 'tool_use' : r.finish === 'max-tokens' ? 'max_tokens' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: r.usage?.outputTokens ?? 0 },
          });
          sse.event({ type: 'message_stop' });
          sse.end();
        } catch (err) {
          const ue = err instanceof UpstreamError ? err : new UpstreamError('server', String((err as Error)?.message ?? err));
          if (sse.started) {
            sse.event({ type: 'error', error: { type: errorTypeOf(ue), message: ue.message } });
            sse.end();
          } else {
            sendError(res, ue, ue.code === 'quota' || ue.unavailable ? lane.candidates(requested, 3) : []);
          }
        } finally {
          res.off('close', onClose);
        }
        return;
      }

      if (url === '/v1/responses' && req.method === 'POST') {
        const body = await readBody(req, limit);
        const requested = String(body.model ?? '');
        const messages: ChatMessage[] = [
          ...(typeof body.instructions === 'string' && body.instructions
            ? [{ role: 'system' as const, content: body.instructions }] : []),
          ...fromResponsesInput(body.input),
        ];
        if (!messages.length) {
          return json(res, 400, { error: { message: 'input 不能为空', type: 'invalid_request_error' } });
        }
        const ac = new AbortController();
        const onClose = () => ac.abort();
        res.on('close', onClose);
        const rid = randomId('resp_');
        try {
          const r = await lane.chat({
            model: requested,
            messages,
            tools: body.tools as ToolDef[] | undefined,
            effort: String(body.reasoning?.effort ?? body.reasoning_effort ?? ''),
            maxTokens: body.max_output_tokens ?? body.max_tokens,
            temperature: body.temperature,
            sessionSeed: String(body.user ?? body.session_seed ?? 'global'),
            turnSeed: body.turn_seed,
            signal: ac.signal,
          });
          const output: any[] = [];
          if (r.text) {
            output.push({
              type: 'message', role: 'assistant', id: randomId('msg_'),
              content: [{ type: 'output_text', text: r.text, annotations: [] }],
            });
          }
          for (const c of r.toolCalls) {
            output.push({
              type: 'function_call', id: randomId('fc_'), call_id: c.id,
              name: c.function.name, arguments: c.function.arguments || '{}',
            });
          }
          const payload = {
            id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000),
            model: r.servedBy, status: 'completed',
            output,
            output_text: r.text,
            usage: r.usage ? {
              input_tokens: r.usage.inputTokens,
              output_tokens: r.usage.outputTokens,
              total_tokens: r.usage.totalTokens || r.usage.inputTokens + r.usage.outputTokens,
            } : undefined,
          };
          if (!body.stream) {
            return json(res, 200, payload, { 'x-zen-gate-served-by': r.servedBy });
          }
          const sse = openaiSse(res);
          sse.chunk({ type: 'response.created', response: { ...payload, status: 'in_progress', output: [] } });
          output.forEach((item, index) => {
            sse.chunk({ type: 'response.output_item.done', output_index: index, item });
          });
          sse.chunk({ type: 'response.completed', response: payload });
          sse.done();
        } catch (err) {
          const ue = err instanceof UpstreamError ? err : new UpstreamError('server', String((err as Error)?.message ?? err));
          sendError(res, ue, ue.code === 'quota' || ue.unavailable ? lane.candidates(requested, 3) : []);
        } finally {
          res.off('close', onClose);
        }
        return;
      }

      if (url === '/v1/systemone' && req.method === 'POST') {
        const body = await readBody(req, limit);
        if (!body?.model || !body?.state || !body?.questions) {
          return json(res, 400, { error: { message: '需要 model / state / questions 三个字段', type: 'invalid_request_error' } });
        }
        try {
          const r = await lane.decide({
            model: String(body.model), state: String(body.state),
            questions: body.questions, sessionSeed: body.session_seed,
          });
          return json(res, 200, { model: r.servedBy, answers: r.answers, ms: r.ms });
        } catch (err) {
          return sendError(res, err instanceof UpstreamError ? err : new UpstreamError('server', String((err as Error)?.message ?? err)));
        }
      }

      if (url === '/v1/probe' && req.method === 'POST') {
        const body = await readBody(req, 1 << 20);
        if (!body?.model) return json(res, 400, { error: { message: '需要 model 字段', type: 'invalid_request_error' } });
        return json(res, 200, await lane.probe(String(body.model)));
      }

      json(res, 404, { error: { message: `未知路径 ${req.method} ${url}`, type: 'invalid_request_error' } });
    } catch (err) {
      json(res, 500, { error: { message: String((err as Error)?.message ?? err), type: 'internal_error' } });
    }
  });

  return { server, lane };
}

function safeJson(s: string): Record<string, any> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** Anthropic 请求 → 统一消息（tool_result 并进 user，thinking 块丢弃） */
function fromAnthropicMessages(body: any): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (typeof body.system === 'string' && body.system) out.push({ role: 'system', content: body.system });
  else if (Array.isArray(body.system)) {
    const text = body.system.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n\n');
    if (text) out.push({ role: 'system', content: text });
  }
  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
    if (m.role === 'assistant') {
      const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
      const calls = blocks.filter((b: any) => b?.type === 'tool_use').map((b: any, i: number) => ({
        id: String(b.id ?? `call_${i}`), type: 'function' as const,
        function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of blocks) {
      if (b?.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x: any) => String(x?.text ?? '')).join('') : '';
        out.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content });
      }
    }
    const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

function fromAnthropicTools(tools: any): ToolDef[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t: any) => ({
    type: 'function' as const,
    function: {
      name: String(t?.name ?? ''),
      description: String(t?.description ?? ''),
      parameters: t?.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/** Responses 的 input → 统一消息（developer 就是 system，不能悄悄丢掉） */
function fromResponsesInput(input: any): ChatMessage[] {
  const items = typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : [];
  const out: ChatMessage[] = [];
  for (const it of items) {
    const type = String(it?.type ?? 'message');
    if (type === 'function_call') {
      out.push({
        role: 'assistant', content: '',
        tool_calls: [{
          id: String(it.call_id ?? it.id ?? ''), type: 'function',
          function: { name: String(it.name ?? ''), arguments: String(it.arguments ?? '{}') },
        }],
      });
      continue;
    }
    if (type === 'function_call_output') {
      out.push({ role: 'tool', tool_call_id: String(it.call_id ?? ''), content: String(it.output ?? '') });
      continue;
    }
    let role = String(it?.role ?? 'user');
    if (role === 'developer') role = 'system';
    if (role !== 'system' && role !== 'user' && role !== 'assistant') role = 'user';
    const content = typeof it?.content === 'string'
      ? it.content
      : Array.isArray(it?.content)
        ? it.content.map((p: any) => String(p?.text ?? p?.input_text ?? p?.output_text ?? '')).join('')
        : '';
    out.push({ role: role as ChatMessage['role'], content });
  }
  return out;
}

/** 启动网关（打印监听地址），返回 server 供外部关闭 */
export async function startZenGate(opts: ZenGateOptions = {}): Promise<Server> {
  const { server, lane } = createZenGate(opts);
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8788;
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const n = await lane.refreshCatalog();
  console.log(`[zen-gate] OpenCode Zen 网关已启动 http://${host}:${port}/v1 （目录 ${n} 个模型）`);
  console.log(`[zen-gate] OpenAI 兼容：${host}:${port}/v1/chat/completions · Anthropic：/v1/messages · 判定：/v1/systemone`);
  return server;
}
