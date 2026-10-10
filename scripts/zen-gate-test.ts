/**
 * OpenCode Zen 网关模块 · 离线自测（不联网）。
 *
 *   node scripts/zen-gate-test.ts
 *
 * 覆盖：会话铸造形状、线协议路由、SystemOne（Jev）判定与 chat 护栏、
 * 指纹门四元组、DSML 清洗、网关 HTTP 端点（mock 上游不可达时的错误语义）。
 */
import { strict as assert } from 'node:assert';
import {
  DsmlScrubber, UpstreamError, applyFingerprint, baseModelId, isSystemOneModel,
  mintSessionId, sessionForConversation, wireFor, endpointFor, ZenLane,
  createZenGate,
} from '../src/zen/index.ts';

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
assert.equal(badDecide.status, 502); // 上游真实打不通 → 502 upstream_error（方向正确的护栏：不是判定模型不该走这）
console.log('✓ 网关 HTTP 端点（Key 护栏 / 目录 / SystemOne 转发语义）');

server.close();
console.log('\n全部通过 ✅');
