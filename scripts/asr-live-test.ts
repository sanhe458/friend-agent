import { readFileSync } from 'node:fs';

/** 对着**正在运行的面板**模拟「用户发来一条语音」，验证 语音→转文字→回复 整条链路 */
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
const pv = (cfg.providers ?? []).find((p: any) => p.id === 'siliconflow');
const KEY = pv?.apiKey;
const BASE = pv?.baseUrl || 'https://api.siliconflow.cn/v1';
const tokenKey = 'panel' + 'Token';
const authKey = String(cfg[tokenKey] ?? '');
const PANEL = 'http://127.0.0.1:8918';
const CHAT = 'voicelive';

const SAY = '帮我记一下，我明天要去成都出差。';

async function speech(text: string): Promise<Buffer> {
  const r = await fetch(BASE + '/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'FunAudioLLM/CosyVoice2-0.5B', input: text,
      voice: 'FunAudioLLM/CosyVoice2-0.5B:alex', response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`TTS 失败(${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

const post = (path: string, body: unknown) =>
  fetch(PANEL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-panel-token': authKey },
    body: JSON.stringify(body),
  }).then((r) => r.json() as any);

console.log('=== ① 造一段真语音 ===');
const audio = await speech(SAY);
console.log(`  ${audio.length} 字节　说的内容：「${SAY}」`);

console.log('=== ② 当作语音消息发给面板 ===');
const r = await post('/api/say', {
  channel: 'panel',
  externalId: CHAT,
  media: [{ kind: 'audio', url: 'data:audio/mpeg;base64,' + audio.toString('base64') }],
});
console.log('  提交:', JSON.stringify(r));

console.log('  等它处理 + 回复…');
await new Promise((res) => setTimeout(res, 12000));

const st = (await fetch(PANEL + '/api/state', { headers: { 'x-panel-token': authKey } }).then((x) => x.json())) as any;
console.log('\n=== ③ 转写结果 ===');
for (const e of st.log ?? []) {
  const t = String(e.text ?? '');
  if (/语音|转文字|识别/.test(t)) console.log('  ', t.slice(0, 170));
}
console.log('\n=== ④ 它的回复（出站）===');
for (const e of (st.log ?? []).filter((x: any) => x.dir === 'out' && x.to === CHAT)) {
  console.log('  →', String(e.text ?? '').slice(0, 200));
}
console.log('\n=== ⑤ 有没有记住「成都」这件事 ===');
const person = (st.persons ?? []).find((p: any) => p.bindings.some((b: any) => b.externalId === CHAT));
if (!person) console.log('  （没建档）');
else {
  const c = await fetch(`${PANEL}/api/chat?channel=panel&externalId=${encodeURIComponent(CHAT)}`, {
    headers: { 'x-panel-token': authKey },
  }).then((x) => x.json()) as any;
  const mem = c.memory ?? [];
  for (const m of mem) console.log('   ⭐', String(m.text ?? '').slice(0, 110));
}
process.exit(0);
