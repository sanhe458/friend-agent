import type { LogEntry } from './app.ts';
import { createApp } from './app.ts';
import { CliAdapter } from './adapters/cli.ts';

const app = createApp();
const settle = (ms = 400) => new Promise<void>((r) => setTimeout(r, ms));

function fmt(e: LogEntry): string {
  const t = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
  if (e.dir === 'in') return `${t}  ← [${e.channel}] ${e.text}`;
  if (e.dir === 'out') return `${t}  → [${e.channel}→${e.to}] ${e.text}`;
  return `${t}  · ${e.text}`;
}

async function cli(): Promise<void> {
  const cliAdapter = new CliAdapter('local');
  app.adapters.add(cliAdapter);
  await cliAdapter.start((m) => { void app.inbound(m); });
}

async function demo(): Promise<void> {
  app.onLog((e) => console.log(fmt(e)));

  console.log('\n=== 1. QQ 上来一条（适配器→身份→队列→前台）===');
  await app.say('qq', '10001', '嗨');
  await settle();

  console.log('\n=== 2. 记一件事（前台写记忆工具）===');
  await app.say('qq', '10001', '记住我下周三要体检');
  await settle();

  console.log('\n=== 3. 跨通道合并：验证必须在「已知通道」内完成 ===');
  app.identity.resolve('telegram', '20002');
  const pending = app.identity.requestMerge(
    { channel: 'telegram', externalId: '20002' },
    { channel: 'qq', externalId: '10001' },
  );
  console.log(`  验证码发往已知通道 ${pending.notify.channel}:${pending.notify.to}  码=${pending.code}`);
  try {
    app.identity.confirmMerge(pending.code, { channel: 'telegram', externalId: '20002' });
    console.log('  ✗ 不该成功');
  } catch (err) {
    console.log('  ✓ 在 TG 上确认被拒：', (err as Error).message);
  }
  const merged = app.identity.confirmMerge(pending.code, { channel: 'qq', externalId: '10001' });
  console.log(`  ✓ 在 QQ 上确认成功 → ${merged.id}｜bindings=${merged.bindings.map((b) => `${b.channel}:${b.externalId}`).join(', ')}`);
  console.log(`  QQ 与 TG 现在是同一个人：`, app.identity.resolve('telegram', '20002').id === merged.id);

  console.log('\n=== 4. 工具间隙插话（秘塔搜索在跑，期间用户改主意）===');
  void app.say('qq', '10001', '搜一下秘塔搜索 API 怎么调');
  await settle(300);
  void app.say('qq', '10001', '算了，改搜微博热搜');
  await settle(6000);

  console.log('\n=== 5. 通用 worker：delegate（立即回执，不阻塞）===');
  await app.say('qq', '10001', '帮我写个爬虫');
  await settle();

  console.log('\n=== 6. 专员：前台直接调（异步工具）===');
  await app.say('qq', '10001', '打开这个网页看看');
  await settle();
  await app.say('qq', '10001', '深度搜索一下秘塔的定价');
  await settle();

  console.log('\n=== 7. 任务跑完 → 结果回注到发起通道 ===');
  await settle(2600);

  console.log('\n=== 8. 问进度（两类任务都在）===');
  await app.say('qq', '10001', '弄好了没');
  await settle();

  console.log('\n=== done ===');
}

if (process.argv.includes('--cli')) {
  await cli();
} else {
  await demo();
  process.exit(0);
}
