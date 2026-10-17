/**
 * OpenCode Zen 网关模块 · 离线自测（不联网）。
 *
 *   node scripts/zen-gate-test.ts
 *
 * 覆盖：会话铸造形状、线协议路由、SystemOne（Jev）判定与 chat 护栏、
 * 指纹门四元组、DSML 清洗、网关 HTTP 端点（Key 护栏 / 目录 / 错误语义）、
 * 三线解码（工具参数分槽、stop_reason 优先级）、失败分类、限流账本、力度预算。
 *
 * 全部离线：网关打的那一点「上游」由本文件里的假上游（127.0.0.1）接住。
 */
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import {
  DsmlScrubber, UpstreamError, applyFingerprint, baseModelId, isSystemOneModel,
  mintSessionId, sessionForConversation, wireFor, endpointFor, ZenLane,
  createZenGate, UPSTREAM_BASE,
} from '../src/zen/index.ts';
import { StreamDecoder } from '../src/zen/decode.ts';
import { ThrottleBook } from '../src/zen/throttle.ts';
import { budgetFor, MIN_BUDGET } from '../src/zen/effort.ts';
import { modelInfo } from '../src/zen/catalog.ts';

// 1. 会话 / 请求 id 形状（ses_ + 12 hex + 14 base62）
const sid = await sessionForConversation('test');
assert.match(sid, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
assert.match(mintSessionId(), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
// 同一种子 → 同一会话（免费档配额按会话计，不能每次换 id）
assert.equal(await sessionForConversation('test'), sid);
assert.equal(baseModelId('mimo-v2.6-flash-free(deep)'), 'mimo-v2.6-flash-free');
console.log('✓ 会话/请求 id 铸造');

// 2. 线协议路由
assert.equal(wireFor('mimo-v2.6-flash-free'), 'chat');
assert.equal(wireFor('union-alpha'), 'messages');
assert.equal(wireFor('muse-spark-1.3-contributor-free'), 'responses');
assert.equal(wireFor('jev-1.13-free'), 'systemone');
assert.equal(endpointFor('jev-1.13-free'), '/zen/v1/systemone');
assert.equal(isSystemOneModel('jev-1.13-free'), true);
assert.equal(isSystemOneModel('mimo-v2.6-flash-free'), false);
console.log('✓ 线协议路由（chat / messages / responses / systemone）');

// 3. SystemOne 护栏：Jev 模型不接受 chat；chat 模型不接受 decide
const lane = new ZenLane({ timeoutMs: 5_000 });
// 先钉住护栏本身：这两条在发请求之前就该抛，跟网络无关
await assert.rejects(
  () => lane.chat({ model: 'jev-1.13-free', messages: [{ role: 'user', content: 'hi' }] }),
  (err: unknown) => err instanceof UpstreamError && /System One/.test(err.message),
);
await assert.rejects(
  () => lane.decide({ model: 'mimo-v2.6-flash-free', state: 'x', questions: { q: { type: 'noul', instructions: 'y' } } }),
  (err: unknown) => err instanceof UpstreamError && /判定模型/.test(err.message),
);
console.log('✓ SystemOne（Jev）护栏');

// 4. 指纹门：四元组必须齐全；调用方已有 bash（改名 pwsh）会被还原
const body: any = { model: 'x', messages: [], tools: [{ type: 'function', function: { name: 'pwsh', parameters: {} } }] };
const rename = applyFingerprint(body);
const names = body.tools.map((t: any) => t.function?.name ?? t.name);
for (const t of ['bash', 'glob', 'grep', 'read']) assert.ok(names.includes(t), `缺四元组 ${t}`);
assert.ok(!names.includes('pwsh'), 'pwsh 应顶替 bash 槽位');
assert.equal(rename.bash, 'pwsh');
console.log('✓ 指纹门四元组 + 工具改名还原表');

// 5. DSML 清洗：整片标记删除；跨片扣住
const scrub = new DsmlScrubber();
assert.equal(scrub.push('a<｜DSML｜ calls>b'), 'ab');
const scrub2 = new DsmlScrubber();
assert.equal(scrub2.push('hello <｜DS'), 'hello ');      // 疑似开头扣住
assert.equal(scrub2.push('ML｜x> world'), ' world');      // 补齐后整片删
assert.equal(scrub2.push('ok'), 'ok');
console.log('✓ DSML 控制标记清洗（含跨片扣住）');

// 6. 网关 HTTP：/healthz、/v1/models、systemone 转发语义、SystemOne chat 护栏
const { server } = createZenGate({ port: 0, apiKey: 'k-test' });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
const base = `http://127.0.0.1:${(addr as any).port}`;

const health = await fetch(`${base}/healthz`);
assert.equal(health.status, 200);

const noKey = await fetch(`${base}/v1/models`);
assert.equal(noKey.status, 401, '无 Key 应 401');
const withKey = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer k-test' } });
assert.equal(withKey.status, 200);
const list = await withKey.json() as any;
assert.ok(list.data.some((m: any) => m.id === 'jev-1.13-free' && m.system_one === true), '目录里要有 jev 且标注 systemOne');

const jevChat = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: 'Bearer k-test', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'jev-1.13-free', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal(jevChat.status, 400);
assert.match((await jevChat.json() as any).error.message, /\/v1\/systemone/);

const badDecide = await fetch(`${base}/v1/systemone`, {
  method: 'POST',
  headers: { authorization: 'Bearer k-test', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'mimo-v2.6-flash-free', state: 'x', questions: {} }),
});
// chat 模型打到判定专线：要么 502 上游拒绝、要么 404 —— 不能是 400「参数不对」那类本地护栏
assert.ok([404, 502].includes(badDecide.status), `实际 ${badDecide.status}`);
console.log('✓ 网关 HTTP 端点（Key 护栏 / 目录 / SystemOne 转发语义）');

server.close();
console.log('\n全部通过 ✅');

// ─────────────────────────────────────────────────────────────────────────────
// 以下为本轮同步上游新增的回归项（全部离线）
// ─────────────────────────────────────────────────────────────────────────────

function reply(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}
function sseResp(frames: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const realFetch = globalThis.fetch;
async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

console.log('\n▶ 7. 指纹门：donor 只能用一次，且不吞四元组槽位');
{
  const body: any = {
    model: 'x', messages: [],
    tools: [
      { type: 'function', function: { name: 'Bash', parameters: {} } },   // 大小写不同 → 就地规范成 bash
      { type: 'function', function: { name: 'glob', parameters: {} } },
    ],
  };
  const rename = applyFingerprint(body);
  const names = body.tools.map((t: any) => t.function?.name);
  assert.deepEqual(names, ['bash', 'glob', 'grep', 'read']);
  assert.equal(rename.bash, 'Bash');
  assert.equal(body.tool_choice, undefined); // 调用方本来就带了工具 → 不强塞 none
}

console.log('\n▶ 8. 失败分类：模型点名的 401 不能当成凭据错误');
{
  const lane2 = new ZenLane();
  let err: any;
  await withFetch((async () => reply(401, '{"error":"ModelError: model is unavailable"}')) as typeof fetch, async () => {
    err = await lane2.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] })
      .then(() => undefined, (e) => e);
  });
  assert.ok(err instanceof UpstreamError);
  assert.equal(err.code, 'server');
  assert.equal(err.unavailable, true);
  assert.ok(lane2.throttled('mimo-v2.6-flash-free'), '模型点名不可用要记进限流账本');
}

console.log('\n▶ 9. 413 限流：换下一个模型接住，servedBy 标实际模型，并用掉一个请求 id');
{
  const seenModels: string[] = [];
  let call = 0;
  const lane3 = new ZenLane({ failoverMax: 2 });
  const r = await withFetch((async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    seenModels.push(body.model);
    call++;
    if (call === 1) return reply(429, '{"error":"FreeUsageLimitError"}', { 'retry-after': '30' });
    return sseResp([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n',
      'data: [DONE]\n',
    ]);
  }) as typeof fetch, () => lane3.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }));
  assert.notEqual(r.servedBy, 'mimo-v2.6-flash-free');
  assert.equal(r.failovers, 1);
  assert.equal(r.text, '你好');
  assert.equal(r.usage?.totalTokens, 5);
  assert.ok(lane3.throttled('mimo-v2.6-flash-free'));
  assert.ok(seenModels.length === 2, `实际请求 ${seenModels.length} 次`);
}

console.log('\n▶ 10. 三线解码：参数分槽 / Anthropic stop_reason 优先 / responses 的 function_call');
{
  // chat：首片同时带 name 和半截参数；并行调用不能串台
  const tool = new Map<number, { name: string; args: string }>();
  const dec = new StreamDecoder('chat', {}, {
    onBlockStart: (i, type, _id, name) => { if (type === 'tool-call') tool.set(i, { name, args: '' }); },
    onToolDelta: (i, _id, _n, d) => { const s = tool.get(i); if (s) s.args += d; },
  });
  dec.decode('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}');
  dec.decode('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}');
  dec.decode('{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"grep","arguments":"{\\"q\\":1}"}}]}}]}');
  dec.decode('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  const res = dec.finish();
  assert.equal(res.finish, 'tool-calls');
  assert.deepEqual([...tool.values()].map((t) => `${t.name}:${t.args}`), ['bash:{"command":"ls"}', 'grep:{"q":1}']);

  // messages：先 message_delta(max_tokens) 后 message_stop —— 不能被 message_stop 改成 stop
  const dec2 = new StreamDecoder('messages', {}, {});
  dec2.decode('{"type":"content_block_start","index":0,"content_block":{"type":"text"}}');
  dec2.decode('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}');
  dec2.decode('{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}');
  dec2.decode('{"type":"message_stop"}');
  const res2 = dec2.finish();
  assert.equal(res2.finish, 'max-tokens');
  assert.equal(res2.sawText, true);

  // responses：item.added 自带 arguments 不能丢
  const calls: any[] = [];
  const dec3 = new StreamDecoder('responses', { bash: 'pwsh' }, {
    onBlockStart: (_i, type, _id, name) => { if (type === 'tool-call') calls.push({ name, args: '' }); },
    onToolDelta: (_i, _id, _n, d) => { if (calls.length) calls[calls.length - 1].args += d; },
  });
  dec3.decode('{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"bash","arguments":"{\\"a\\":"}}');
  dec3.decode('{"type":"response.function_call_arguments.delta","output_index":0,"delta":"1}"}');
  dec3.decode('{"type":"response.output_item.done","output_index":0}');
  dec3.decode('{"type":"response.completed"}');
  const res3 = dec3.finish();
  assert.equal(res3.finish, 'stop');
  assert.deepEqual(calls, [{ name: 'pwsh', args: '{"a":1}' }]); // 名字按 rename 表还原

  // 工具参数拼不成 JSON → 整轮降级成 max-tokens，而不是当成功交出去
  const dec4 = new StreamDecoder('chat', {}, {});
  dec4.decode('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"bash","arguments":"{\\"a\\":"}}]}}]}');
  dec4.decode('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  assert.equal(dec4.finish().finish, 'max-tokens');
}

console.log('\n▶ 11. 纯思考被切断 → checkpoint 续写一次拿到答案');
{
  let call = 0;
  const lane5 = new ZenLane({ recoveryTimeoutMs: 30_000 });
  const r = await withFetch((async (_u: any, init: any) => {
    call++;
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (call === 1) {
      return sseResp(['data: {"choices":[{"delta":{"reasoning_content":"想了一半"}}]}\n']);
    }
    // 续写请求必须把 checkpoint 带上，并且要求「不要调工具」
    const last = body.messages[body.messages.length - 1];
    assert.match(String(last?.content ?? ''), /Interrupted analysis checkpoint/);
    assert.match(String(last?.content ?? ''), /想了一半/);
    assert.equal(body.tool_choice, 'none');
    return sseResp([
      'data: {"choices":[{"delta":{"content":"答案"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n',
    ]);
  }) as typeof fetch, () => lane5.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: '算一下' }], turnSeed: 't1' }));
  assert.equal(r.recovered, true);
  assert.equal(r.text, '答案');
  assert.equal(r.usage?.inputTokens, 7);
  assert.equal(call, 2);
}

console.log('\n▶ 12. 正文写到一半被切：不续写，直接报错（不能把半截答案当完整）');
{
  let call = 0;
  const lane6 = new ZenLane();
  let err: any;
  await withFetch((async () => {
    call++;
    return sseResp(['data: {"choices":[{"delta":{"content":"写了一半"}}]}\n']);
  }) as typeof fetch, async () => {
    err = await lane6.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] })
      .then(() => undefined, (e) => e);
  });
  assert.ok(err instanceof UpstreamError);
  assert.equal(err.code, 'transport');
  assert.equal(call, 1);
}

console.log('\n▶ 13. 限流账本：429 立刻标记 / 到点自动失效 / 深拷贝不外泄');
{
  const book = new ThrottleBook();
  book.markThrottled('m', 0.05); // 50ms
  assert.equal(book.throttled('m'), true);
  const snapshot = book.note('m');
  snapshot.episodes![0].start = 0; // 改副本不能影响账本
  assert.notEqual(book.note('m').episodes![0].start, 0);
  book.markOK('m');
  assert.equal(book.throttled('m'), false);
  assert.equal(book.recoveryETA('m'), 0);

  const book2 = new ThrottleBook();
  book2.markThrottled('x', 0.05); // 秒：50ms
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(book2.throttled('x'), false, '冷却到点应自动失效');
}

console.log('\n▶ 14. 力度预算：天花板优先，模型容量/调用方只能压低');
{
  const mimo = modelInfo('mimo-v2.6-flash-free'); // 131072 / 思考关不掉
  assert.equal(budgetFor('light', mimo, undefined, 32_768), 2_048 * 2);
  assert.equal(budgetFor('balanced', mimo, 1000, 32_768), 1000);
  // deep = 模型容量（deep 不带天花板），调用方没传时就是 maxOutput
  assert.equal(budgetFor('deep', mimo, undefined, undefined), mimo.maxOutput);
  // 显式传了 max_tokens 也压不下 MIN_BUDGET 以下
  assert.equal(budgetFor('deep', mimo, 100, undefined), MIN_BUDGET);
  assert.ok(budgetFor('light', mimo, 1, 1) >= MIN_BUDGET);
  const union = modelInfo('union-alpha');       // 不支持力度 → 只看容量
  assert.equal(budgetFor('light', union, undefined, 32_768), 32_768);
}

console.log('\n▶ 15. 网关 HTTP：模型目录字段 / served_by 头 / Anthropic 端点');
{
  // 假上游：所有请求都回一段合法的 chat SSE
  const upstream: Server = createServer((req, res) => {
    if (String(req.url).includes('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'gpt-5-paid' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n');
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const savedBase = UPSTREAM_BASE;
  (UPSTREAM_BASE as any); // 只读常量提示：下面用 lane 的注入替身
  const upUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  // UPSTREAM_BASE 是导出常量，不能改；这里把 fetch 的目标改写过去
  const real = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any) => real(String(input).replace(savedBase, upUrl), init)) as typeof fetch;
  try {
    const { server, lane: gl } = createZenGate({ port: 0, apiKey: 'k' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer k' } })).json() as any;
    assert.ok(models.data.every((m: any) => !m.id.includes('gpt-5-paid')), '付费 id 不能出现在免费车道目录');
    assert.ok(models.data.some((m: any) => m.id === 'mimo-v2.6-flash-free' && m.wire === 'chat'));

    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.headers.get('x-zen-gate-served-by'), 'mimo-v2.6-flash-free');
    const chatJson = await chat.json() as any;
    assert.equal(chatJson.choices[0].message.content, 'hi');

    const anth = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(anth.status, 200);
    const anthJson = await anth.json() as any;
    assert.equal(anthJson.type, 'message');
    assert.equal(anthJson.content.find((b: any) => b.type === 'text')?.text, 'hi');
    assert.equal(anthJson.stop_reason, 'end_turn');

    const budget = await (await fetch(`${base}/v1/budget?model=mimo-v2.6-flash-free`, { headers: { authorization: 'Bearer k' } })).json() as any;
    assert.equal(budget.levels.length, 3);
    assert.equal(budget.levels.find((l: any) => l.id === 'balanced').isDefault, true);
    void gl;
    server.close();
  } finally {
    globalThis.fetch = real;
    upstream.close();
  }
}

console.log('\n同步上游新增回归项全部通过 ✅');
