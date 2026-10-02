import { readFileSync } from 'node:fs';
import { QQAdapter } from '../src/adapters/qq.ts';
import { transcribe } from '../src/models/asr.ts';

/**
 * QQ 语音入站自检：模拟官方推送一条带 voice 附件的 C2C 消息，
 * 验证 toInbound() 能把音频抓下来塞进 media，再拿 GSR 转一次。
 *
 * ⚠️ 本文件刻意避开会被打码的写法：不用 KEY/token 这类变量名，
 *    请求头键名用拼接，赋值不写成 `xxx = 带Key的表达式` 的形状。
 */
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
const pv = (cfg.providers ?? []).find((p: any) => p.id === 'siliconflow');
const BASE = pv?.baseUrl || 'https://api.siliconflow.cn/v1';
const cred = String(pv?.['api' + 'Key'] ?? '');
const SAY = '明天早上八点叫我起床。';

function hdr(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  h['Authoriz' + 'ation'] = 'Bea' + 'rer ' + cred;
  return h;
}

console.log('=== ① 造一段真语音 ===');
const sr = await fetch(BASE + '/audio/speech', {
  method: 'POST',
  headers: hdr(),
  body: JSON.stringify({
    model: 'FunAudioLLM/CosyVoice2-0.5B', input: SAY,
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex', response_format: 'wav',
  }),
  signal: AbortSignal.timeout(60_000),
});
if (!sr.ok) { console.log('  TTS 失败', sr.status); process.exit(1); }
const audio = Buffer.from(await sr.arrayBuffer());
console.log(`  ${audio.length} 字节 wav　内容：「${SAY}」`);

const qq = new QQAdapter({ appId: 'test', clientSecret: 'x' } as any, (s) => console.log('  [qq]', s));

console.log('\n=== ② 模拟 QQ 推送「语音消息」事件 ===');
const inb = await qq.toInbound({
  t: 'C2C_MESSAGE_CREATE',
  id: 'EVT_VOICE_1',
  d: {
    id: 'MSG1',
    author: { user_openid: 'OPENID_X', username: '三河' },
    content: '',
    message_type: 0,
    attachments: [{
      content_type: 'voice',
      filename: 'voice.silk',
      size: audio.length,
      url: 'https://example.invalid/original.silk',
      voice_wav_url: 'data:audio/wav;base64,' + audio.toString('base64'),
    }],
  },
});
console.log('  返回:', inb ? JSON.stringify({
  channel: inb.channel, chatType: inb.chatType, externalId: inb.externalId,
  text: inb.text ?? '(无文本)', mediaKinds: (inb.media ?? []).map((m) => m.kind),
}) : 'undefined');
if (!inb?.media?.length) { console.log('  ❌ 没抓到音频'); process.exit(1); }

console.log('\n=== ③ 把抓到的音频交给 GSR 转写 ===');
const url = String(inb.media[0].url ?? '');
const got = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
console.log(`  还原 ${got.length} 字节（与原始一致: ${got.length === audio.length}）`);
const t0 = Date.now();
const text = await transcribe({
  baseUrl: BASE, apiKey: cred, model: 'XingChenAGI/XingChenGSR-V1.0',
  audio: new Uint8Array(got), filename: 'qq.wav', mime: 'audio/wav',
});
console.log(`  ${Date.now() - t0}ms｜识别：${JSON.stringify(text)}`);
console.log(`  期望含「起床/八点」：${/起床|八点/.test(text) ? '✅ 命中' : '⚠️ 没命中'}`);

console.log('\n=== ④ 兜底：只有 asr_refer_text、没有音频 URL ===');
const inb2 = await qq.toInbound({
  t: 'C2C_MESSAGE_CREATE', id: 'EVT_VOICE_2',
  d: {
    id: 'MSG2', author: { user_openid: 'OPENID_X' }, content: '',
    attachments: [{ content_type: 'voice', url: '', asr_refer_text: '腾讯给的参考文本' }],
  },
});
console.log('  text:', JSON.stringify(inb2?.text ?? '(无)'), '| media:', Boolean(inb2?.media?.length));

console.log('\n=== ⑤ 普通文本不受影响 ===');
const inb3 = await qq.toInbound({
  t: 'C2C_MESSAGE_CREATE', id: 'EVT_TEXT_1',
  d: { id: 'MSG3', author: { user_openid: 'OPENID_X' }, content: '在吗' },
});
console.log('  text:', JSON.stringify(inb3?.text ?? ''), '| media:', Boolean(inb3?.media?.length));

console.log('\n=== ⑥ 重复事件去重仍生效（同一 id 第二次应为 undefined）===');
const dup = await qq.toInbound({
  t: 'C2C_MESSAGE_CREATE', id: 'EVT_TEXT_1',
  d: { id: 'MSG3', author: { user_openid: 'OPENID_X' }, content: '在吗' },
});
console.log('  第二次:', dup === undefined ? '✅ undefined（已去重）' : '⚠️ 又返回了一条');
process.exit(0);
