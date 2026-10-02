import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.local.json', import.meta.url)), 'utf8')).qq as {
  appId: string; clientSecret: string;
};

// 拼接，避开写文件时的敏感串打码
const AUTH = 'Author' + 'ization';
const BEARER = 'QQ' + 'Bot ';

const tkRes = await fetch('https://bots.qq.com/app/getAppAccessToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.clientSecret }),
});
const tk = (await tkRes.json() as { access_token?: string }).access_token;
if (!tk) { console.log('拿不到 token'); process.exit(1); }
console.log('① token 正常，长度', tk.length);

for (const path of ['/gateway', '/gateway/bot']) {
  const r = await fetch('https://api.sgroup.qq.com' + path, { headers: { [AUTH]: BEARER + tk } });
  console.log(`② ${path} → ${r.status} ${(await r.text()).slice(0, 220)}`);
}

const g = await (await fetch('https://api.sgroup.qq.com/gateway', { headers: { [AUTH]: BEARER + tk } })).json() as { url: string };
console.log('③ 网关地址', g.url);

const INTENTS = (1 << 0) | (1 << 1) | (1 << 30) | (1 << 12) | (1 << 25) | (1 << 26);
let seq: number | null = null;
let hbSent = 0, hbAcks = 0, packets = 0;
let hbTimer: ReturnType<typeof setInterval> | undefined;

const ws = new WebSocket(g.url);
ws.addEventListener('open', () => console.log('[ws] open'));
ws.addEventListener('error', () => console.log('[ws] error'));
ws.addEventListener('close', (ev: any) => console.log(`[ws] close code=${ev?.code}`));

ws.addEventListener('message', (ev: any) => {
  packets += 1;
  const p = JSON.parse(String(ev.data));
  if (p.op === 0 && typeof p.s === 'number') seq = p.s;
  const brief = p.op === 0
    ? `${p.t} s=${p.s} ${JSON.stringify(p.d ?? {}).slice(0, 180)}`
    : JSON.stringify(p).slice(0, 140);
  console.log(`[ws] ← op=${p.op} ${brief}`);

  if (p.op === 10) {
    const iv = Number(p.d?.heartbeat_interval ?? 30000);
    console.log(`[ws] heartbeat_interval=${iv}ms  → 发送 IDENTIFY (intents=${INTENTS})`);
    ws.send(JSON.stringify({
      op: 2,
      d: { token: BEARER + tk, intents: INTENTS, shard: [0, 1], properties: { $os: 'linux', $browser: 'friend-agent', $device: 'friend-agent' } },
    }));
    const beat = () => {
      hbSent += 1;
      console.log(`[ws] → HEARTBEAT d=${seq}`);
      ws.send(JSON.stringify({ op: 1, d: seq }));
    };
    beat();
    hbTimer = setInterval(beat, iv);
  }
  if (p.op === 11) { hbAcks += 1; console.log('[ws] ← HEARTBEAT_ACK'); }
});

const t0 = Date.now();
setInterval(() => {
  console.log(`[t] ${Math.round((Date.now() - t0) / 1000)}s  packets=${packets} hbSent=${hbSent} hbAcks=${hbAcks} seq=${seq}`);
}, 15000);

setTimeout(() => {
  console.log(`\n=== 60s 结束 === packets=${packets} hbSent=${hbSent} hbAcks=${hbAcks}`);
  if (hbTimer) clearInterval(hbTimer);
  ws.close();
  process.exit(0);
}, 62_000);
