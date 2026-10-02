import { createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.local.json', import.meta.url)), 'utf8')).qq as {
  appId: string; clientSecret: string;
};
const TOKEN = 'fr_cebcd08baa61fc11de65536d';

function seedOf(secret: string): Buffer {
  let s = secret;
  while (s.length < 32) s += s;
  return Buffer.from(s.slice(0, 32), 'utf8');
}
const priv = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedOf(cfg.clientSecret)]),
  format: 'der', type: 'pkcs8',
});

// 找一个已存在的 QQ 私聊身份（用三河真实的 openid，这样能真发到他 QQ）
const st = await (await fetch('http://127.0.0.1:8918/api/state', { headers: { 'x-panel-token': TOKEN } })).json() as any;
const binding = (st.persons || [])
  .flatMap((p: any) => p.bindings.map((b: any) => ({ p, b })))
  .filter((x: any) => x.b.channel === 'qq' && x.b.externalId.startsWith('c2c:'))
  .find((x: any) => !x.b.externalId.includes('TEST_OPENID'));
if (!binding) { console.log('没有真实 QQ 私聊身份'); process.exit(1); }

const openid = binding.b.externalId.replace(/^c2c:/, '');
const text = process.argv[2] ?? '在吗？这条是端到端自检';

const evt = {
  id: 'E2E_' + Date.now(),
  op: 0,
  t: 'C2C_MESSAGE_CREATE',
  d: {
    id: 'E2E_MSG_' + Date.now(),
    content: text,
    author: { user_openid: openid },
  },
};
const body = JSON.stringify(evt);
const ts = String(Math.floor(Date.now() / 1000));
const sig = edSign(null, Buffer.from(ts + body), priv).toString('hex');

console.log(`模拟入站：openid=${openid.slice(0, 12)}… text="${text}"`);
const r = await fetch('https://qq.sanhe.com.mp/qq/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts },
  body,
});
console.log('回调响应:', r.status, await r.text());

console.log('\n等待引擎生成并发送…');
for (let i = 0; i < 20; i++) {
  await new Promise((r2) => setTimeout(r2, 2000));
  const s = await (await fetch('http://127.0.0.1:8918/api/state', { headers: { 'x-panel-token': TOKEN } })).json() as any;
  const qq = s.log.filter((e: any) => e.channel === 'qq');
  const out = qq.filter((e: any) => e.dir === 'out');
  const sendOk = qq.filter((e: any) => e.text.includes('发送✓'));
  const sendFail = qq.filter((e: any) => e.text.includes('发送失败') || e.text.includes('被拒'));
  const running = s.tasks ? undefined : undefined;
  console.log(`  [${(i + 1) * 2}s] 出站=${out.length} 发送成功=${sendOk.length} 发送失败/降级=${sendFail.length}`);
  if (out.length > 0 && (sendOk.length > 0 || sendFail.length > 0)) {
    console.log('\n=== QQ 侧相关日志 ===');
    for (const e of qq.filter((x: any) => /发送|回调|msg_id/.test(x.text)).slice(-8)) {
      console.log('   ·', e.text.slice(0, 140));
    }
    console.log('\n=== 出站内容 ===');
    for (const e of out.slice(-3)) console.log('   →', e.text.slice(0, 160));
    break;
  }
}
process.exit(0);
