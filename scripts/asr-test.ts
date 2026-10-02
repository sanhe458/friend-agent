import { readFileSync } from 'node:fs';
import { transcribe } from '../src/models/asr.ts';

/**
 * ASR 端到端自检：先用 TTS 造一段真人语音，再拿去识别，看识别结果对不对。
 * 这样不用等真实用户发语音，就能验证「模型能不能用 + 我们的调用代码对不对」。
 */
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
const pv = (cfg.providers ?? []).find((p: any) => p.id === 'siliconflow');
if (!pv?.apiKey) { console.log('没找到 siliconflow 的 key'); process.exit(1); }
const BASE = pv.baseUrl || 'https://api.siliconflow.cn/v1';
const KEY = pv.apiKey;

const SAY = '今天天气不错，我们一起去公园散步吧。';

async function makeSpeech(text: string): Promise<{ bytes: Buffer; mime: string }> {
  const r = await fetch(BASE + '/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: text,
      voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`TTS 失败(${r.status}) ${(await r.text()).slice(0, 160)}`);
  return { bytes: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg' };
}

console.log('=== ① 造语音（TTS）===');
let audio: { bytes: Buffer; mime: string };
try {
  audio = await makeSpeech(SAY);
  console.log(`  ✅ 生成 ${audio.bytes.length} 字节 ${audio.mime}`);
  console.log(`  期望识别出：「${SAY}」`);
} catch (err) {
  console.log('  ❌ ' + (err as Error).message);
  process.exit(1);
}

console.log('\n=== ② 逐个候选 ASR 模型实测 ===');
const CANDIDATES = [
  'XingChenAGI/XingChenGSR-V1.0',
  'XingChenAGI/XingChenASR-V3.2',
];
const ok: string[] = [];
for (const model of CANDIDATES) {
  const t0 = Date.now();
  try {
    const text = await transcribe({
      baseUrl: BASE, apiKey: KEY, model,
      audio: new Uint8Array(audio.bytes), filename: 'test.mp3', mime: 'audio/mpeg',
    });
    const ms = Date.now() - t0;
    const hit = text.includes('天气') || text.includes('公园');
    console.log(`  ${hit ? '✅' : '⚠️ '} ${model}`);
    console.log(`       ${ms}ms｜识别：${JSON.stringify(text).slice(0, 120)}`);
    if (hit) ok.push(model);
  } catch (err) {
    console.log(`  ❌ ${model}`);
    console.log('       ' + (err as Error).message.slice(0, 160));
  }
}

console.log('\n=== 结论 ===');
console.log(ok.length ? `  可用模型：${ok.join('、')}` : '  没有可用模型');
