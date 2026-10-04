import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../src/config.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { ModelRegistry } from '../src/models/registry.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Person } from '../src/core/types.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { createNullPersistence, createSqlitePersistence } from '../src/store/persist.ts';
import { ARCHIVE_RETENTION_DAYS, DailyContextManager, dayKey } from '../src/context/daily.ts';
import { defaultCommands } from '../src/core/commands.ts';

/**
 * 每日上下文翻篇 · 离线自测（不打任何 API）。
 *
 * 跑法：node --experimental-strip-types --experimental-sqlite scripts/daily-context-test.ts
 *
 * 覆盖：
 *   - lastHistoryAt / clearHistory（新持久层接口）
 *   - 同日不翻篇 / 跨天翻篇（归档落盘 + 摘要进记忆 + 历史清空）
 *   - 查询 API（listDays / readDay / search）
 *   - 摘要生成失败的兜底
 *   - 归档写盘失败 → 放弃翻篇、历史不丢
 *   - 过期归档清理（保留 60 天）
 *   - 没接持久化时也能翻篇
 */
const ws = mkdtempSync(join(tmpdir(), 'daily-ctx-'));
const clean = () => { try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on('exit', clean);

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const now = Date.now();
const today = dayKey(now);
const yesterday = dayKey(now - 86_400_000);
const summarizeOk = async (t: string) => `【测试摘要】输入 ${t.length} 字`;
const HIST = [
  { role: 'user' as const, content: '我最喜欢吃橘子，家里还有一只橘猫叫团子' },
  { role: 'assistant' as const, content: '记下了：爱吃橘子，猫叫团子。' },
  { role: 'user' as const, content: '明天下午三点提醒我开会' },
  { role: 'assistant' as const, content: '好，明天 15:00 提醒你开会。' },
];

// ── 0. 新持久层接口 ─────────────────────────────
console.log('\n▶ 持久层接口（lastHistoryAt / clearHistory）');
const db0 = createSqlitePersistence(join(ws, 'base.db'));
db0.saveHistory('p_x', { role: 'user', content: '你好' });
db0.saveHistory('p_x', { role: 'assistant', content: '嗯' });
check('lastHistoryAt 能取到最后一条的时间', typeof db0.lastHistoryAt('p_x') === 'number');
check('没有历史返回 undefined', db0.lastHistoryAt('p_none') === undefined);
db0.clearHistory('p_x');
check('clearHistory 后历史为空', db0.loadHistory('p_x', 10).length === 0 && db0.lastHistoryAt('p_x') === undefined);
db0.close();

// ── 1. 同日不翻篇 ─────────────────────────────
console.log('\n▶ 同日不翻篇');
const db = createSqlitePersistence(join(ws, 'main.db'));
const memory = new MemoryStore(db);
const daily = new DailyContextManager({
  memory, persist: db, archiveDir: join(ws, 'archives'),
  summarize: summarizeOk, log: (s) => console.log(`    [log] ${s}`),
});
const pid = 'p_test1';
daily.markDay(pid, today);
check('同一天 rollover 返回 undefined', (await daily.rolloverIfNeeded(pid, HIST, now)) === undefined);

// ── 2. 跨天翻篇 ─────────────────────────────
console.log('\n▶ 跨天翻篇（归档 + 摘要进记忆 + 清历史）');
const db2 = createSqlitePersistence(join(ws, 'main2.db'));
const memory2 = new MemoryStore(db2);
const daily2 = new DailyContextManager({
  memory: memory2, persist: db2, archiveDir: join(ws, 'archives'),
  summarize: summarizeOk, log: (s) => console.log(`    [log] ${s}`),
});
const pid2 = 'p_test2';
daily2.markDay(pid2, yesterday);
const r = await daily2.rolloverIfNeeded(pid2, HIST, now);
check('翻篇有结果', !!r, r ? `${r.day} · ${r.messages} 条` : '无');
check('归档文件存在', !!r && existsSync(r.file), r?.file.replace(ws, '…'));
const doc = r ? (JSON.parse(readFileSync(r.file, 'utf8')) as { day: string; messages: unknown[]; summary: string }) : undefined;
check('归档内容完整（4 条消息）', doc?.messages.length === 4);
check('归档带当天摘要', !!doc?.summary?.includes('测试摘要'));
check('归档日期正确', doc?.day === yesterday);
const mems = memory2.all(pid2);
check('摘要写进了记忆（含 daily-summary 与日期标签）',
  mems.some((m) => m.text.includes('对话摘要') && m.tags.includes('daily-summary') && m.tags.includes(yesterday)));
check('持久层历史已清空', db2.loadHistory(pid2, 10).length === 0 && db2.lastHistoryAt(pid2) === undefined);
check('翻篇后日期标成今天', daily2.dayOf(pid2) === today);
// 真实链路里引擎装载历史时总会先 markDay，这里按同样的顺序调用
daily2.markDay('p_empty', yesterday);
check('空历史跨天：只标记不报错', (await daily2.rolloverIfNeeded('p_empty', [], now)) === undefined && daily2.dayOf('p_empty') === today);

// ── 3. 查询 API ─────────────────────────────
console.log('\n▶ 查询 API（AI 的 archive_query 背后）');
const days = daily2.listDays(pid2);
check('listDays 列出归档日', days.length === 1 && days[0].day === yesterday && days[0].count === 4, JSON.stringify(days));
check('listDays 不串别人的档', daily2.listDays('p_other').length === 0);
const read = daily2.readDay(pid2, yesterday);
check('readDay 读到摘要与消息', !!read && (read.summary ?? '').includes('测试摘要') && read.messages.length === 4);
check('readDay 读不到不存在的天', daily2.readDay(pid2, '2000-01-01') === undefined && daily2.readDay(pid2, 'bad') === undefined);
const hits = daily2.search(pid2, '橘子');
check('search 命中关键词', hits.length === 2 && hits.every((h) => h.day === yesterday), `${hits.length} 条`);
check('search 搜不到别人的档', daily2.search('p_other', '橘子').length === 0);
check('search 无关词返回空', daily2.search(pid2, '不存在的词xyz').length === 0);

// ── 3.5 手动翻篇（/new 的底层：rolloverNow 跳过跨天检查）─────────────────────────────
console.log('\n▶ 手动翻篇 rolloverNow（/new 底层）');
{
  const db4 = createSqlitePersistence(join(ws, 'main4.db'));
  const memory4 = new MemoryStore(db4);
  const daily4 = new DailyContextManager({
    memory: memory4, persist: db4, archiveDir: join(ws, 'archives'),
    summarize: summarizeOk, log: (s) => console.log(`    [log] ${s}`),
  });
  daily4.markDay('p_test4', today); // 同一天！
  check('对照：同一天 rolloverIfNeeded 不翻篇', (await daily4.rolloverIfNeeded('p_test4', HIST, now)) === undefined);
  const r4 = await daily4.rolloverNow('p_test4', HIST, now);
  check('同一天 rolloverNow 也能翻篇', !!r4 && r4.messages === 4 && r4.day === today);
  check('归档落盘且摘要进记忆', !!r4 && existsSync(r4.file) && memory4.all('p_test4').some((m) => m.tags.includes('daily-summary') && m.tags.includes(today)));
  check('历史已清空', db4.loadHistory('p_test4', 10).length === 0 && db4.lastHistoryAt('p_test4') === undefined);
  check('空历史 → undefined', (await daily4.rolloverNow('p_test4b', [], now)) === undefined);
  db4.close();
}

// ── 3.6 /new 命令（defaultCommands）─────────────────────────────
console.log('\n▶ /new 命令');
{
  const cmdReg = defaultCommands({
    personBindings: () => [], status: () => ({}), tasks: () => [], jobs: () => [],
    newContext: async (pid) => (pid === 'p_cmd' ? { messages: 5 } : undefined),
  });
  const runCmd = async (name: string, personId: string) => await cmdReg.get(name)?.run({
    person: { id: personId, displayName: '测试', bindings: [], createdAt: now },
    msg: { channel: 'panel', chatType: 'private', externalId: 'e', at: now, text: '/' + name },
    args: '',
  });
  const ok = await runCmd('new', 'p_cmd');
  check('/new 有归档时回复确认', ok?.reply?.includes('已翻篇') === true && ok.reply.includes('5 条'), ok?.reply);
  const empty = await runCmd('new', 'p_nobody');
  check('/new 无可归档时回复提示', empty?.reply?.includes('没有可归档') === true);
  const help = await runCmd('help', 'p_cmd');
  check('/help 列出 /new', help?.reply?.includes('/new') === true);
}

// ── 4. 摘要失败兜底 ─────────────────────────────
console.log('\n▶ 摘要生成失败兜底');
const db3 = createSqlitePersistence(join(ws, 'main3.db'));
const daily3 = new DailyContextManager({
  memory: new MemoryStore(db3), persist: db3, archiveDir: join(ws, 'archives'),
  summarize: async () => { throw new Error('模拟模型挂了'); },
  log: (s) => console.log(`    [log] ${s}`),
});
daily3.markDay('p_test3', yesterday);
const r3 = await daily3.rolloverIfNeeded('p_test3', HIST, now);
check('摘要失败也能翻篇', !!r3 && (r3.summary ?? '').includes('摘要生成失败'));
check('兜底文案指向归档', !!r3 && r3.summary.includes(yesterday));
db3.close();

// ── 5. 写盘失败 → 放弃翻篇，历史不丢 ─────────────────────────────
console.log('\n▶ 归档写盘失败（不丢历史）');
const ws5 = join(ws, 'ws5');
mkdirSync(ws5, { recursive: true });
writeFileSync(join(ws5, 'archives'), '我是一个普通文件，占住了 archives 这个名字');
const db5 = createSqlitePersistence(join(ws5, 'main5.db'));
db5.saveHistory('p_test5', { role: 'user', content: '这条历史很宝贵' });
const daily5 = new DailyContextManager({
  memory: new MemoryStore(db5), persist: db5, archiveDir: join(ws5, 'archives'),
  summarize: summarizeOk, log: (s) => console.log(`    [log] ${s}`),
});
daily5.markDay('p_test5', yesterday);
const r5 = await daily5.rolloverIfNeeded('p_test5', HIST, now);
check('写盘失败返回 undefined', r5 === undefined);
check('历史一条不少', db5.loadHistory('p_test5', 10).length === 1);
db5.close();

// ── 6. 过期归档清理（保留 60 天）─────────────────────────────
console.log('\n▶ 过期归档清理');
const keepOld = join(ws, 'archives', dayKey(now - (ARCHIVE_RETENTION_DAYS + 1) * 86_400_000));
const keepNew = join(ws, 'archives', dayKey(now - (ARCHIVE_RETENTION_DAYS - 1) * 86_400_000));
const keepToday = join(ws, 'archives', today);
for (const d of [keepOld, keepNew, keepToday]) {
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${encodeURIComponent(pid2)}.json`), '{}');
}
const purged = daily2.purgeExpired(now);
check('删掉了超期目录', purged === 1 && !existsSync(keepOld), `清理 ${purged} 天`);
check('保留期内与当天的还在', existsSync(keepNew) && existsSync(keepToday));
check('非日期目录不碰', (() => {
  const stray = join(ws, 'archives', 'not-a-day');
  mkdirSync(stray, { recursive: true });
  daily2.purgeExpired(now);
  return existsSync(stray);
})());

// ── 7. 没接持久化也能翻篇 ─────────────────────────────
console.log('\n▶ 无持久化（内存模式）');
const daily7 = new DailyContextManager({
  memory: new MemoryStore(createNullPersistence()), archiveDir: join(ws, 'archives'),
  summarize: summarizeOk,
});
daily7.markDay('p_test7', yesterday);
const r7 = await daily7.rolloverIfNeeded('p_test7', HIST, now);
check('内存模式翻篇成功', !!r7 && existsSync(r7.file) && daily7.dayOf('p_test7') === today);

// ── 8. 引擎级端到端：跨天第一条消息触发翻篇（本地 mock 模型端点，不打外网）──
console.log('\n▶ 引擎级端到端（ReplyEngine + mock 模型）');
{
  // mock OpenAI 兼容端点：记录收到的 messages，回一句固定的话
  const seen: Array<Array<{ role: string; content: string }>> = [];
  const mock = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { seen.push(JSON.parse(body).messages ?? []); } catch { seen.push([]); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '收到', finish_reason: 'stop' } }], usage: {} }));
    });
  });
  await new Promise<void>((ok) => mock.listen(0, '127.0.0.1', ok));
  const port = (mock.address() as AddressInfo).port;

  // 预置「昨天」的历史：先建库写入，再直接用 node:sqlite 把时间戳改到昨天
  // （saveHistory 恒打当前时间，模拟跨天只能这么改——真实场景里这行就是昨天写的）
  const e2eDb = join(ws, 'e2e.db');
  const dbE1 = createSqlitePersistence(e2eDb);
  dbE1.saveHistory('p_e2e', { role: 'user', content: '昨天的话：我爱吃橘子' });
  dbE1.saveHistory('p_e2e', { role: 'assistant', content: '记住了' });
  dbE1.close();
  const raw = new DatabaseSync(e2eDb);
  raw.prepare('update history set at = ?').run(now - 86_400_000);
  raw.close();

  const dbE2 = createSqlitePersistence(e2eDb);
  const memoryE = new MemoryStore(dbE2);
  const dailyE = new DailyContextManager({
    memory: memoryE, persist: dbE2, archiveDir: join(ws, 'archives'),
    summarize: summarizeOk, log: (s) => console.log(`    [log] ${s}`),
  });
  const notices: string[] = [];
  const cfg: AppConfig = {
    metasoScope: 'webpage', searchSize: 5, panelPort: 0,
    providers: [{ id: 'mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' }],
    models: [{ id: 'm1', providerId: 'mock', model: 'mock-model', meta: { contextWindow: 100000, tools: true } }],
    roles: { reply: 'm1' },
    compression: { triggerRatio: 0.75, targetRatio: 0.5, keepRecentTurns: 8 },
  };
  const engine = new ReplyEngine({
    memory: memoryE,
    tools: new ToolRegistry(),
    orch: new Orchestrator(),
    models: new ModelRegistry(() => cfg),
    persist: dbE2,
    daily: dailyE,
    notice: (t) => notices.push(t),
  });
  const person: Person = { id: 'p_e2e', displayName: '端到端', bindings: [], createdAt: now };

  const out = await engine.handle(
    person,
    { channel: 'panel', chatType: 'private', externalId: 'u1', text: '今天聊点新的', at: now },
    { drain: () => [] },
  );

  check('引擎正常回复', out.text === '收到', out.text.slice(0, 30));
  // 钱眼断言：发给模型的第一条请求 = system + 当前这句话（昨天的 2 条已被翻篇清走）
  check('新上下文干净（只有今天的内容）', seen[0]?.length === 2, `发给模型 ${seen[0]?.length} 条`);
  check('翻篇通知已发出', notices.some((t) => t.includes('上下文翻篇') && t.includes(yesterday)));
  check('昨天的对话已归档', dailyE.listDays('p_e2e').some((d) => d.day === yesterday && d.count === 2));
  check('摘要已进记忆', memoryE.all('p_e2e').some((m) => m.tags.includes('daily-summary') && m.tags.includes(yesterday)));
  const after = dbE2.loadHistory('p_e2e', 10);
  check('本轮对话正常入历史（2 条，全是今天的）', after.length === 2 && after[0].content === '今天聊点新的');
  check('lastHistoryAt 回到今天', dayKey(dbE2.lastHistoryAt('p_e2e') ?? 0) === today);
  // 同一天再聊一轮：不再翻篇
  seen.length = 0;
  await engine.handle(
    person,
    { channel: 'panel', chatType: 'private', externalId: 'u1', text: '继续聊', at: now },
    { drain: () => [] },
  );
  check('同日第二轮不再翻篇', seen[0]?.length === 4 && !notices.slice(1).some((t) => t.includes('上下文翻篇')), `发给模型 ${seen[0]?.length} 条`);

  // /new：不等跨天手动翻篇（此时历史 = 两轮对话共 4 条）
  const rNew = await engine.newContext('p_e2e');
  check('engine.newContext 手动翻篇', !!rNew && rNew.messages === 4 && rNew.day === today);
  check('手动翻篇归档落盘（今天的目录）', dailyE.listDays('p_e2e').some((d) => d.day === today && d.count === 4));
  check('手动翻篇记忆里有了今天的摘要', memoryE.all('p_e2e').filter((m) => m.tags.includes('daily-summary')).length === 2);
  check('刚翻完再翻 → undefined（没有可归档）', (await engine.newContext('p_e2e')) === undefined);
  seen.length = 0;
  await engine.handle(
    person,
    { channel: 'panel', chatType: 'private', externalId: 'u1', text: '重新开始', at: now },
    { drain: () => [] },
  );
  check('手动翻篇后上下文干净（2 条）', seen[0]?.length === 2, `发给模型 ${seen[0]?.length} 条`);

  mock.close();
  dbE2.close();
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
