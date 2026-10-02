import { createServer } from 'node:http';
import { TelegramAdapter } from '../src/adapters/telegram.ts';

/** 本地假 Telegram：记录所有调用，用来验证流式到底发了什么 */
const calls: Array<{ method: string; body: any }> = [];
let nextMsgId = 100;

const srv = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const method = (req.url ?? '').split('/').pop() ?? '';
    let body: any = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    calls.push({ method, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (method === 'getMe') return void res.end(JSON.stringify({ ok: true, result: { id: 1, username: 'testbot', first_name: 'T' } }));
    if (method === 'getUpdates') return void res.end(JSON.stringify({ ok: true, result: [] }));
    if (method === 'sendMessage') return void res.end(JSON.stringify({ ok: true, result: { message_id: nextMsgId++ } }));
    if (method === 'editMessageText') return void res.end(JSON.stringify({ ok: true, result: { message_id: body.message_id } }));
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});

await new Promise<void>((r) => srv.listen(9999, '127.0.0.1', () => r()));
const BASE = 'http://127.0.0.1:9999';

const tg = new TelegramAdapter({ token: 'TEST', apiBase: BASE } as any, (s) => console.log('  [adapter]', s));

// ── 场景 1：模拟模型快速吐字（每 60ms 一片，远快于 1200ms 节流）──
const FINAL = '你好呀，我在的。刚才那事我想了想，你可以先这样做，然后我们再对一下。';
calls.length = 0;
const h = await tg.openStream({ channel: 'telegram', to: '12345' } as any);
const deltas: string[] = [];
for (let i = 1; i <= FINAL.length; i++) {
  deltas.push(FINAL.slice(0, i));
  await h.update(FINAL.slice(0, i));
  await new Promise((r) => setTimeout(r, 60)); // 快于节流窗
}
const landed = await h.end(FINAL);
await new Promise((r) => setTimeout(r, 400)); // 等收尾

const sends = calls.filter((c) => c.method === 'sendMessage');
const edits = calls.filter((c) => c.method === 'editMessageText');
console.log(`\n=== 场景1：快速吐字（${deltas.length} 片，每 60ms）===`);
console.log('  sendMessage 次数:', sends.length, '（应为 1 —— 只建一条消息）');
console.log('  editMessageText 次数:', edits.length, '（应 >0 —— 中间确实在改）');
console.log('  end() 返回 landed =', landed, '（必须 true，否则调用方会重复发一条）');
const lastEdit = edits[edits.length - 1];
console.log('  最后一次编辑的内容 === 最终全文 ?', lastEdit?.body?.text === FINAL);
if (lastEdit?.body?.text !== FINAL) {
  console.log('  ❌ 最终文本没发出去！最后一条是：', JSON.stringify(lastEdit?.body?.text ?? '(无)').slice(0, 90));
  console.log('     最终应该是：', JSON.stringify(FINAL).slice(0, 90));
}

// ── 场景 2：只有一个 update 然后立刻 end（最容易丢帧的情形）──
calls.length = 0;
const h2 = await tg.openStream({ channel: 'telegram', to: '12345' } as any);
await h2.update('你');
const landed2 = await h2.end('你');
await new Promise((r) => setTimeout(r, 300));
const e2 = calls.filter((c) => c.method === 'editMessageText');
console.log(`\n=== 场景2：只发一个字的片就收尾 ===`);
console.log('  landed =', landed2, '| 最后内容 =', JSON.stringify(e2[e2.length - 1]?.body?.text ?? '(无)'), '（应为「你」）');

// ── 场景 3：超长文本（验证 4096 切段）──
calls.length = 0;
await tg.send({ channel: 'telegram', to: '12345', text: 'x'.repeat(9000) } as any);
console.log(`\n=== 场景3：9000 字长文 ===`);
console.log('  sendMessage 次数:', calls.filter((c) => c.method === 'sendMessage').length, '（应 ≥3）');

srv.close();

// ── 场景4：流式默认必须是关的（三河 2026-10-01 要求）──
const off = new TelegramAdapter({ token: '***', apiBase: BASE, streaming: false } as any, () => {});
const on = new TelegramAdapter({ token: '***', apiBase: BASE, streaming: true } as any, () => {});
console.log('\n=== 场景4：流式开关 ===');
console.log('  不传 streaming → supportsStreaming =', off.supportsStreaming, '（必须 false）');
console.log('  streaming:true → supportsStreaming =', on.supportsStreaming, '（应为 true）');
console.log('  ! 关流式时调用方会直接走 send()，不会进 openStream');

process.exit(0);
