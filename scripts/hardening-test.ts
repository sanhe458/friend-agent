/**
 * 加固轮回归自测（离线，不打任何真实 API）。
 *
 * 跑法：node scripts/hardening-test.ts
 *
 * 覆盖这一轮修掉的东西，一条都不能悄悄回退：
 *   A. SSE 解析：`data:` 不带空格也要认；读到一半断了要归类成 transport 错误并释放 reader
 *   B. 工具参数累积：首片同时带 name+arguments 不能丢；并行工具调用不能串台
 *   C. rerank 的 index 必须映射回**原始**候选下标（中间夹空文本时会错位）
 *   D. metaUrl SSRF 护栏：内网/元数据地址拒、非同源剥 Authorization
 *   E. cron 可行性预检：`0 0 30 2 *` 这类永不可能命中的表达式必须立刻返回
 *   F. 同日二次翻篇：必须**合并**归档，不能把当天早先那份覆盖掉
 *   G. safeEmit：入站回调抛异常/reject 不能变成 unhandled rejection
 *   H. MCP 握手失败：必须杀掉子进程、连接不能被标记成 connected（否则永远不再重连）
 *   I. 同 person 记忆分片：count()/forgetPerson()/入队去重
 */
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rerank } from '../src/models/rerank.ts';
import { checkMetaUrl } from '../src/models/meta.ts';
import { postStreamed, UpstreamError } from '../src/zen/upstream.ts';
import { ZenLane } from '../src/zen/lane.ts';
import { nextCronAt } from '../src/core/schedule.ts';
import { DailyContextManager } from '../src/context/daily.ts';
import { safeEmit } from '../src/adapters/adapter.ts';
import { McpManager } from '../src/mcp/client.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { MemoryStore } from '../src/memory/store.ts';

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/** 抓 unhandled rejection：这类问题以前是"进程静默死亡"，测试里必须抓得到 */
const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);
process.on('unhandledRejection', onUnhandled);

// ── 把全局 fetch 换成本地假上游（SSE 测试用）──────────────
const realFetch = globalThis.fetch;
const sse = (frames: string[], opts: { splitHeader?: boolean } = {}) => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const withStub = async <T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> => {
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
};

console.log('\n▶ A. SSE 解析（data: 无空格 / 流中断归类）');
{
  const seen: string[] = [];
  await withStub((async () => sse([
    'data: {"a":1}\n',
    'data:{"b":2}\n',          // ← 不带空格，以前整片丢掉
    'data:{"c":3}',            // ← 末尾没有换行
  ])) as typeof fetch, async () => {
    await postStreamed({ path: '/x', body: {}, session: 's', requestId: 'r', onData: (p) => seen.push(p) });
  });
  check('data: 无空格也能解析', seen.length === 3, `收到 ${seen.length} 片`);
  check('末尾不带换行的最后一片不丢', seen[2]?.includes('"c":3'), seen[2] ?? '');

  // 流读到一半挂掉 → 必须是 UpstreamError('transport')，而不是光秃秃的 TypeError
  let err: unknown;
  await withStub((async () => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"partial":1}\n'));
      c.error(new TypeError('terminated'));   // 上游断流
    },
  }))) as typeof fetch, async () => {
    await postStreamed({ path: '/x', body: {}, session: 's', requestId: 'r', onData: () => {} }).catch((e) => { err = e; });
  });
  check('流中断归类为 UpstreamError(transport)',
    err instanceof UpstreamError && (err as UpstreamError).code === 'transport',
    err instanceof Error ? err.message : String(err));
}

console.log('\n▶ B. 工具参数累积（首片带 name+arguments / 并行调用）');
{
  const lane = new ZenLane();
  // 第 1 片同时带 name 和**部分** arguments；第 2、3 片续传
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}\n',
    // 第 2 个工具并行进来，参数不能被第一个吃掉
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"grep","arguments":"{\\"q\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"1}"}}]}}]}\n',
    'data: [DONE]\n',
  ];
  const r = await withStub((async () => sse(frames)) as typeof fetch, () =>
    lane.chat({ model: 'grok-code', messages: [{ role: 'user', content: '跑一下' }] }));
  const calls = r.toolCalls;
  check('两个工具调用都识别出来', calls.length === 2, `实际 ${calls.length}`);
  check('首片带的那段参数没被丢', calls[0]?.function.arguments === '{"command":"ls"}', calls[0]?.function.arguments ?? '(none)');
  check('并行调用的参数没有串台', calls[1]?.function.arguments === '{"q":1}', calls[1]?.function.arguments ?? '(none)');
  check('工具名还原了（指纹改名后）', calls[0]?.function.name === 'bash' && calls[1]?.function.name === 'grep',
    calls.map((c) => c.function.name).join(','));
}

console.log('\n▶ C. rerank 的 index 映射回原始下标');
{
  // 假重排服务：按包含"苹果"打分，返回的是**发送顺序**的下标
  const server = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const docs = (JSON.parse(buf || '{}').documents ?? []) as string[];
      const results = docs
        .map((d, i) => ({ index: i, relevance_score: d.includes('苹果') ? 0.9 : 0.1 }))
        .sort((a, b) => b.relevance_score - a.relevance_score);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  // 第 0 条空串会被过滤掉 → 发送的是 ['B','C']，「C」的下标应该是 2（原始下标），不是 1
  const hits = await rerank({
    baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
    model: 'm', query: '他喜欢什么',
    documents: ['', 'B 无关', 'C 他喜欢吃苹果'],
  });
  server.close();
  check('命中项映射回原始下标 2', hits[0]?.index === 2, `拿到 ${hits[0]?.index}`);
}

console.log('\n▶ D. metaUrl SSRF 护栏');
{
  const base = 'https://api.example.com/v1';
  check('云元数据地址被拒', !checkMetaUrl('http://169.254.169.254/latest/meta-data/', base).ok);
  check('内网 10.x 被拒', !checkMetaUrl('https://10.1.2.3/models', base).ok);
  check('内网 192.168 被拒', !checkMetaUrl('https://192.168.1.1/models', base).ok);
  check('http 公网被拒（只放本机）', !checkMetaUrl('http://evil.example.com/models', base).ok);
  check('file: 协议被拒', !checkMetaUrl('file:///etc/passwd', base).ok);
  check('本机 http 放行（ollama 这类）', checkMetaUrl('http://127.0.0.1:11434/v1/models', base).ok);
  const same = checkMetaUrl('https://api.example.com/v1/models', base);
  check('同源保留 Authorization', same.ok && same.sameOrigin === true);
  const other = checkMetaUrl('https://other.example.com/models', base);
  check('异域公网放行但剥 Authorization', other.ok && other.sameOrigin === false);
}

console.log('\n▶ E. cron 可行性预检');
{
  const t0 = Date.now();
  check('永不可能的 2 月 30 日 → undefined', nextCronAt('0 0 30 2 *', Date.now()) === undefined);
  check('永不可能的 4 月 31 日 → undefined', nextCronAt('0 0 31 4 *', Date.now()) === undefined);
  check('常见 daily 仍可用', nextCronAt('0 9 * * *', Date.now()) > Date.now());
  check('整批判定不卡事件循环（< 1s）', Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
}

console.log('\n▶ F. 同日二次翻篇要合并归档（不能覆盖）');
{
  const dir = mkdtempSync(join(tmpdir(), 'fa-hardening-'));
  let summarized = 0;
  const mgr = new DailyContextManager({
    archiveDir: join(dir, 'archives'),
    memory: { write: () => ({ text: '', tags: [], channel: '', at: 0, hot: false }) },
    summarize: async () => { summarized += 1; return '摘要' + summarized; },
    log: () => {},
  });
  const pid = 'p_merge_test';
  await mgr.rolloverNow(pid, [
    { role: 'user', content: '早上好' },
    { role: 'assistant', content: '早上好呀' },
  ], Date.now());
  await mgr.rolloverNow(pid, [
    { role: 'user', content: '晚上好' },
  ], Date.now());

  const days = mgr.listDays(pid);
  const doc = days.length ? mgr.readDay(pid, days[0].day) : undefined;
  check('同一天仍只有一份归档', days.length === 1, JSON.stringify(days));
  check('两次翻篇的消息都还在（3 条）', (doc?.messages.length ?? 0) === 3, `实际 ${doc?.messages.length}`);
  const found = mgr.search(pid, '早上好');
  check('早上的对话还能搜到', found.some((h) => h.text.includes('早上好')));
  check('摘要也更新成了第二轮', doc?.summary === '摘要2', doc?.summary ?? '(none)');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n▶ G. safeEmit：入站异常不外泄');
{
  const logs: string[] = [];
  safeEmit(async () => { throw new Error('ASR 通道炸了'); },
    { channel: 'qq', chatType: 'private', externalId: '1', text: 'hi', at: Date.now() },
    (s) => logs.push(s));
  safeEmit(() => { throw new Error('同步抛'); },
    { channel: 'tg', chatType: 'private', externalId: '1', text: 'hi', at: Date.now() },
    (s) => logs.push(s));
  safeEmit(null, { channel: 'x', chatType: 'private', externalId: '1', text: '', at: Date.now() }, (s) => logs.push(s));
  await new Promise((r) => setTimeout(r, 30));
  check('异常被记日志而不是逃逸', logs.length === 2, logs.join(' | '));
  check('没有产生 unhandled rejection', unhandled.length === 0, `${unhandled.length} 个`);
}

console.log('\n▶ H. MCP 握手失败要收尸、且不能卡死成 connected');
{
  const MARK = 'fa-mcp-bad-' + Date.now();
  const logs: string[] = [];
  const mgr = new McpManager(new ToolRegistry(), (s) => logs.push(s));

  // 一个对 initialize 直接回 JSON-RPC error 的 MCP 服务器
  const script = `/* ${MARK} */
const rl = require('node:readline').createInterface({ input: process.stdin, terminal: false });
rl.on('line', (l) => {
  try {
    const m = JSON.parse(l);
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -1, message: 'boom' } }) + '\\n');
    }
  } catch {}
});
setInterval(() => {}, 1000);`;
  const cfg = { id: 'bad', command: process.execPath, args: ['-e', script] };

  await mgr.applyAll([cfg]);
  check('握手失败有日志', logs.some((l) => l.includes('连接失败')), logs[0] ?? '(无日志)');

  // 修复前：失败的 conn 还留在 #conns 里且 connected=true → 这次会**直接跳过**
  logs.length = 0;
  await mgr.applyAll([cfg]);
  check('失败后还能再试（没被卡死成 connected）', logs.some((l) => l.includes('连接失败')));

  mgr.stopAll();
  await new Promise((r) => setTimeout(r, 120));
  const ps = execSync('ps -eo cmd 2>/dev/null || true', { encoding: 'utf8' });
  check('没有孤儿 MCP 子进程', !ps.includes(MARK));
}

console.log('\n▶ I. 记忆分片：count / forgetPerson / 入队去重');
{
  const store = new MemoryStore();
  store.write('p_a', { text: 'a1', tags: [], channel: 'qq', at: Date.now(), hot: true });
  store.write('p_a', { text: 'a2', tags: [], channel: 'qq', at: Date.now(), hot: true });
  store.write('p_b', { text: 'b1', tags: [], channel: 'qq', at: Date.now(), hot: true });
  check('count 只数条数', store.count('p_a') === 2 && store.count('p_b') === 1);
  const before = store.count('p_a');
  store.forgetPerson('p_a');
  check('forgetPerson 清掉整个分片', store.count('p_a') === 0 && before === 2);
  check('别人的分片不受影响', store.count('p_b') === 1);
}

console.log('\n▶ J. 向量补算：启动 backfill 有上限，新写入的不会被饿死');
{
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try {
        const input = (JSON.parse(buf || '{}').input ?? []) as string[];
        seen.push(...input.map(String));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: input.map((_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })),
          usage: { total_tokens: input.length },
        }));
      } catch {
        res.writeHead(400).end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  // 假持久层：库里躺着 300 条**没有向量**的老记忆（换嵌入模型后的典型场景）
  const legacy = Array.from({ length: 300 }, (_, i) => ({
    personId: 'p_legacy',
    item: { id: i + 1, text: 'old-' + i, tags: [], channel: 'qq', at: Date.now(), hot: false } as any,
  }));
  const persist = {
    enabled: true,
    loadMemories: () => legacy,
    saveMemory: () => 1,
    saveMemoryVec: () => {},
  } as unknown as import('../src/store/persist.ts').Persistence;

  const store = new MemoryStore(persist, {
    embedding: () => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' }),
    rerank: () => undefined,
  });
  store.write('p_legacy', { text: 'FRESH', tags: [], channel: 'qq', at: Date.now(), hot: false });

  for (let i = 0; i < 300 && !seen.includes('FRESH'); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  server.close();

  check('启动 backfill 不超过每人 200 条上限', seen.filter((t) => t.startsWith('old-')).length <= 200,
    `补算了 ${seen.filter((t) => t.startsWith('old-')).length} 条老记忆`);
  check('新写入的没有被几百条老记忆饿死', seen.includes('FRESH'),
    seen.includes('FRESH') ? `第 ${seen.indexOf('FRESH') + 1} 个就算到` : `只算了 ${seen.length} 条`);
}

await new Promise((r) => setTimeout(r, 50));
process.removeListener('unhandledRejection', onUnhandled);
check('全程没有 unhandled rejection', unhandled.length === 0, `${unhandled.length} 个`);

console.log(failed ? `\n${failed} 项未通过 ❌` : '\n全部通过 ✅');
process.exit(failed ? 1 : 0);
