import { createApp } from '/root/.openclaw/workspace/projects/friend-agent/src/app.ts';

const phase = process.argv[2] ?? 'write';
const app = createApp();

if (phase === 'write') {
  console.log('[phase 1] 写入一批数据…');

  // 身份（含跨通道合并）
  const p = app.identity.resolve('qq', 'persist1', '测试甲');
  app.identity.resolve('telegram', 'persist2');
  const pend = app.identity.requestMerge(
    { channel: 'telegram', externalId: 'persist2' },
    { channel: 'qq', externalId: 'persist1' },
  );
  const merged = app.identity.confirmMerge(pend.code, { channel: 'qq', externalId: 'persist1' });
  app.identity.setPreferred(merged.id, 'qq');
  console.log('  person:', merged.id, 'bindings:', merged.bindings.map((b) => `${b.channel}:${b.externalId}`).join(', '));

  // 记忆
  app.memory.write(merged.id, { text: '他喜欢喝美式，不加糖', tags: ['fact'], channel: 'qq', at: Date.now(), hot: true });

  // 历史 + 事件（走过引擎，走的是规则桩还是模型取决于角色配置）
  await app.say('qq', 'persist1', '记住我下周三要去体检');
  await new Promise((r) => setTimeout(r, 1500));

  // 任务
  app.orch.dispatch({
    personId: merged.id,
    origin: { personId: merged.id, channel: 'qq', externalId: 'persist1' },
    prompt: '（持久化测试任务）',
    kind: 'general',
  });

  console.log('  记忆条数:', app.memory.all(merged.id).length);
  console.log('  历史条数:', app.engine.history(merged.id).length);
  console.log('  事件条数:', app.engine.transcript(merged.id).length);
  console.log('  任务条数:', app.orch.list(merged.id).length);
  app.persist.close();
  console.log('[phase 1] 完成，已 close()');
  process.exit(0);
}

// phase 2：全新进程，只读
console.log('[phase 2] 新进程，从库里读…');
const people = app.identity.all();
console.log('  persons:', people.length);
for (const who of people) {
  console.log(`   · ${who.id} ${who.displayName} preferred=${who.preferredChannel ?? '-'} bindings=${who.bindings.map((b) => b.channel + ':' + b.externalId).join(', ')}`);
  console.log(`     memories=${app.memory.all(who.id).length} history=${app.engine.history(who.id).length} events=${app.engine.transcript(who.id).length} tasks=${app.orch.list(who.id).length}`);
  const m = app.memory.all(who.id);
  if (m.length) console.log('     记忆内容:', m.map((x) => x.text).join(' | '));
  const h = app.engine.history(who.id);
  if (h.length) console.log('     最后一条历史:', JSON.stringify(h[h.length - 1]).slice(0, 120));
}
app.persist.close();
process.exit(0);
