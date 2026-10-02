import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 官方文档给的种子派生：把 secret 重复拼接到 >=32 字节，再截前 32 字节 */
function seedOf(secret: string): Buffer {
  let s = secret;
  while (s.length < 32) s += s;
  return Buffer.from(s.slice(0, 32), 'utf8');
}
function privOf(secret: string) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedOf(secret)]),
    format: 'der', type: 'pkcs8',
  });
}
function pubOf(secret: string) {
  const spki = createPublicKey(privOf(secret)).export({ format: 'der', type: 'spki' }) as Buffer;
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), spki.subarray(spki.length - 32)]),
    format: 'der', type: 'spki',
  });
}

// ── ① 对官方测试向量 ────────────────────────────────
const OFFICIAL = {
  secret: 'DG5g3B4j9X2KOErG',
  plainToken: 'Arq0D5A61EgUu4OxUvOp',
  eventTs: '1725442341',
  expect: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
};
const got = edSign(null, Buffer.from(OFFICIAL.eventTs + OFFICIAL.plainToken), privOf(OFFICIAL.secret)).toString('hex');
console.log('① 官方向量比对');
console.log('   期望:', OFFICIAL.expect.slice(0, 48) + '…');
console.log('   实算:', got.slice(0, 48) + '…');
console.log('   结果:', got === OFFICIAL.expect ? '✅ 完全一致 —— 算法正确' : '❌ 不一致，算法有问题');

if (got !== OFFICIAL.expect) process.exit(1);

// ── ② 对真实部署的回调端点做端到端 ──────────────────
const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.local.json', import.meta.url)), 'utf8')).qq as {
  appId: string; clientSecret: string;
};
const URL_ = 'https://qq.sanhe.com.mp/qq/webhook';

// 2a) op=13 地址验证
const vBody = JSON.stringify({ d: { plain_token: OFFICIAL.plainToken, event_ts: OFFICIAL.eventTs }, op: 13 });
const vRes = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: vBody });
const vJson = await vRes.json() as { plain_token: string; signature: string };
console.log('\n② op=13 地址验证');
console.log('   HTTP', vRes.status, '| 返回字段:', Object.keys(vJson).join(','));
console.log('   我实现的签名是否自洽:', verifySelf(cfg.clientSecret, OFFICIAL.eventTs, OFFICIAL.plainToken, vJson.signature) ? '✅' : '❌');

// 2b) 伪造一条 C2C 消息事件（用真实 secret 签名）
const evt = {
  id: 'TEST_EVT_1',
  op: 0,
  t: 'C2C_MESSAGE_CREATE',
  d: {
    id: 'TEST_MSG_1',
    content: '你好（这是本地签名冒烟测试）',
    author: { user_openid: 'TEST_OPENID_A' },
  },
};
const body = JSON.stringify(evt);
const ts = String(Math.floor(Date.now() / 1000));
const sig = edSign(null, Buffer.from(ts + body), privOf(cfg.clientSecret)).toString('hex');
const r1 = await fetch(URL_, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts },
  body,
});
console.log('\n③ 伪造 C2C 事件（真实 secret 签名）');
console.log('   HTTP', r1.status, await r1.text());

// 2c) 错误签名应被拒
const r2 = await fetch(URL_, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': 'ab'.repeat(64), 'X-Signature-Timestamp': ts },
  body,
});
console.log('   错误签名应被拒 → HTTP', r2.status, r2.status === 401 ? '✅' : '❌');

function verifySelf(secret: string, t: string, pt: string, signature: string): boolean {
  try {
    return edVerify(null, Buffer.from(t + pt), pubOf(secret), Buffer.from(signature, 'hex'));
  } catch { return false; }
}
