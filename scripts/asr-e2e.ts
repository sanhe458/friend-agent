import { readFileSync } from 'node:fs';
import { getApp } from '../src/app.ts';

/**
 * 端到端：把一段真语音当作**用户发来的语音消息**塞进 inbound，
 * 走完「下载 → ASR → 当文本理解 → 回复」整条链路。
 * 这样不用真等用户发语音，就能验证装配是通的。
 */
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
const pv = (cfg.providers ?? []).find((p: any) => p.id === 'siliconflow');
const BASE = pv?.baseUrl || 'https://api.siliconflow.cn/v1';
const KEY = pv?.apiKey;

const SAY = '帮我记一下，我明天要去成都出差。';

async function makeSpeech(text: string): Promise<Buffer> {
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

const app = getApp();
const chatId = 'voicetest';

console.log('=== 造语音 ===');
const audio = await makeSpeech(SAY);
console.log(`  ${audio.length} 字节　内容：「${SAY}」`);

console.log('=== 当作语音消息塞进 inbound ===');
const t0 = Date.now();
await app.inbound({
  channel: 'panel',
  chatType: 'private',
  externalId: chatId,
  media: [{ kind: 'audio', url: 'data:audio/mpeg;base64,' + audio.toString('base64') }],
  at: Date.now(),
});
console.log(`  耗时 ${Date.now() - t0}ms`);

// 等回复落定
await new Promise((r) => setTimeout(r, 3000));

console.log('\n=== 相关日志 ===');
for (const e of app.log.slice(-40)) {
  const t = String(e.text ?? '');
  if (/语音|转文字|识别/.test(t)) console.log('  [处理]', t.slice(0, 150));
}
console.log('\n=== 出站（它应该真的回复了）===');
for (const e of app.log.slice(-40)) {
  if (e.dir === 'out') console.log('  →', e.channel, '/', e.to, '|', String(e.text ?? '').slice(0, 140));
}

console.log('\n=== 记忆里有没有记住「成都」 ===');
const p = app.identity.all().find((x) => x.bindings.some((b) => b.externalId === chatId));
if (!p) { console.log('  （没建档？）'); } else {
  const mem = app.memory.list ? app.memory.list(p.id) : [];
  const hit = (mem as any[]).filter((m: any) => /成都|出差/.test(String(m.text ?? '')));
  console.log('  档案:', p.id, p.displayName, '| 记忆条数:', (mem as any[]).length);
  for (const m of hit) console.log('   ⭐', String((m as any).text).slice(0, 100));
  if (!hit.length) console.log('  （没有直接命中，可能被概括进别的记忆里了）');
}
process.exit(0);
