/**
 * OpenCode Zen 计划代理网关 · HTTP 层。
 *
 * 把免费车道封装成标准 OpenAI 兼容接口，任何支持自定义 base_url 的
 * Agent/客户端都能直接接：
 *
 *   GET  /v1/models              模型目录（含 jev-* 判定模型，标注 systemOne）
 *   POST /v1/chat/completions    OpenAI 兼容对话（429 自动 failover，x-zen-gate-served-by 标注实际模型）
 *   POST /v1/systemone           Jev 型 System One 判定专线（choice / score / noul）
 *   POST /v1/probe               单模型体检
 *   GET  /healthz                存活探针
 *
 * 配了 apiKey 时，/v1/* 需要 Authorization: Bearer <key>。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { UpstreamError, isSystemOneModel } from './upstream.ts';
import { ZenLane, type ChatMessage, type ToolDef } from './lane.ts';

export interface ZenGateOptions {
  host?: string;
  port?: number;
  /** 访问 /v1/* 需要的 API Key；为空则不校验（仅建议回环地址这么干） */
  apiKey?: string;
  lane?: ZenLane;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, limit = 8e6): Promise<any> =>
  new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (v: any) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      buf += c;
      if (buf.length > limit) { try { req.destroy(); } catch { /* ignore */ } finish({}); }
    });
    req.on('end', () => { try { finish(buf ? JSON.parse(buf) : {}); } catch { finish({}); } });
    req.on('error', () => finish({}));
    req.on('close', () => finish({}));
  });

export function createZenGate(opts: ZenGateOptions = {}): { server: Server; lane: ZenLane } {
  const lane = opts.lane ?? new ZenLane();
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (url === '/healthz') return json(res, 200, { ok: true });

      // /v1/* 统一做 Key 护栏
      if (url.startsWith('/v1/') && opts.apiKey) {
        const auth = String(req.headers.authorization ?? '');
        if (auth !== `Bearer ${opts.apiKey}`) {
          return json(res, 401, { error: { message: '无效的 API Key', type: 'invalid_request_error' } });
        }
      }

      if (url === '/v1/models' && req.method === 'GET') {
        await lane.refreshCatalog();
        return json(res, 200, {
          object: 'list',
          data: lane.catalog().map((m) => ({
            id: m.id, object: 'model', owned_by: 'opencode-zen',
            wire: m.wire, system_one: m.systemOne,
            context_window: m.contextWindow, max_output: m.maxOutput,
            vision: m.vision, reasoning: m.reasoning, blurb: m.blurb,
          })),
        });
      }

      if (url === '/v1/chat/completions' && req.method === 'POST') {
        const body = await readBody(req);
        if (!Array.isArray(body?.messages) || !body.messages.length) {
          return json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request_error' } });
        }
        if (isSystemOneModel(String(body.model ?? ''))) {
          return json(res, 400, {
            error: {
              message: `${body.model} 是 System One 判定模型：请改用 POST /v1/systemone，或换 chat 模型`,
              type: 'invalid_request_error',
            },
          });
        }
        const t0 = Date.now();
        try {
          const r = await lane.chat({
            model: String(body.model ?? ''),
            messages: body.messages as ChatMessage[],
            tools: body.tools as ToolDef[] | undefined,
            maxTokens: body.max_tokens ?? body.max_completion_tokens,
            temperature: body.temperature,
            sessionSeed: String(body.user ?? body.session_seed ?? 'global'),
            turnSeed: body.turn_seed,
            signal: req.destroyed ? undefined : undefined,
          });
          return json(res, 200, {
            id: `chatcmpl-zen-${Date.now().toString(36)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: r.servedBy,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: r.text, tool_calls: r.toolCalls.length ? r.toolCalls : undefined },
              finish_reason: r.toolCalls.length ? 'tool_calls' : 'stop',
            }],
            usage: r.usage ? {
              prompt_tokens: r.usage.inputTokens,
              completion_tokens: r.usage.outputTokens,
              total_tokens: r.usage.totalTokens,
            } : undefined,
          });
        } catch (err) {
          return sendUpstreamError(res, err);
        }
      }

      if (url === '/v1/systemone' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body?.model || !body?.state || !body?.questions) {
          return json(res, 400, { error: { message: '需要 model / state / questions 三个字段', type: 'invalid_request_error' } });
        }
        try {
          const r = await lane.decide({
            model: String(body.model), state: String(body.state),
            questions: body.questions, sessionSeed: body.session_seed,
          });
          return json(res, 200, {
            model: r.servedBy, answers: r.answers, ms: r.ms,
          });
        } catch (err) {
          return sendUpstreamError(res, err);
        }
      }

      if (url === '/v1/probe' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body?.model) return json(res, 400, { error: { message: '需要 model 字段', type: 'invalid_request_error' } });
        const r = await lane.probe(String(body.model));
        return json(res, 200, r);
      }

      json(res, 404, { error: { message: `未知路径 ${req.method} ${url}`, type: 'invalid_request_error' } });
    } catch (err) {
      json(res, 500, { error: { message: String((err as Error)?.message ?? err), type: 'internal_error' } });
    }
  });

  return { server, lane };
}

/** 上游错误 → 客户端响应（保留语义：429 限流 / 403 地区门 / 5xx 上游故障） */
function sendUpstreamError(res: ServerResponse, err: unknown): void {
  if (err instanceof UpstreamError) {
    const status = err.code === 'quota' ? 429
      : err.code === 'region' ? 403
      : err.code === 'credential' ? 401
      : err.code === 'aborted' ? 504
      : 502;
    const headers: Record<string, string> = {};
    if (err.retryAfter) headers['retry-after'] = String(err.retryAfter);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify({
      error: { message: err.message, type: 'upstream_error', code: err.code, unavailable: err.unavailable || undefined },
    }));
    return;
  }
  json(res, 500, { error: { message: String((err as Error)?.message ?? err), type: 'internal_error' } });
}

/** 启动网关（打印监听地址），返回 server 供外部关闭 */
export async function startZenGate(opts: ZenGateOptions = {}): Promise<Server> {
  const { server, lane } = createZenGate(opts);
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8788;
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const n = await (lane as ZenLane).refreshCatalog();
  console.log(`[zen-gate] OpenCode Zen 网关已启动 http://${host}:${port}/v1 （目录 ${n} 个模型）`);
  console.log('[zen-gate] 接入示例：baseUrl = http://127.0.0.1:' + port + '/v1，model = mimo-v2.6-flash-free');
  return server;
}
