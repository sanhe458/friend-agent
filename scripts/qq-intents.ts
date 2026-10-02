import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.local.json', import.meta.url)), 'utf8')).qq as {
  appId: string; clientSecret: string;
};
const AUTH = 'Author' + 'ization';
const BEARER = 'QQ' + 'Bot ';

const tk = (await (await fetch('https://bots.qq.com/app/getAppAccessToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.clientSecret }),
})).json() as { access_token: string }).access_token;

const g = await (await fetch('https://api.sgroup.qq.com/gateway', { headers: { [AUTH]: BEARER + tk } })).json() as { url: string };

/** 用指定 intents 试连一次，返回结果描述 */
function probe(label: string, intents: number): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(g.url);
    let done = false;
    const finish = (s: string) => { if (done) return; done = true; try { ws.close(); } catch { /* ignore */ } resolve(s); };
    ws.addEventListener('error', () => finish(`${label}: WS 错误`));
    ws.addEventListener('close', (ev: any) => finish(`${label}: 被关闭 code=${ev?.code}`));
    ws.addEventListener('message', (ev: any) => {
      const p = JSON.parse(String(ev.data));
      if (p.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: { token: BEARER + tk, intents, shard: [0, 1] } }));
      } else if (p.op === 0 && p.t === 'READY') {
        finish(`${label}: ✅ READY（intents 被接受）`);
      } else if (p.op === 9) {
        finish(`${label}: ❌ op9 INVALID SESSION ${JSON.stringify(p.d).slice(0, 120)}`);
      }
    });
    setTimeout(() => finish(`${label}: ⏱ 8s 无 READY 也无关闭`), 8000);
  });
}

const cases: Array<[string, number]> = [
  ['intents=0（什么都不订阅）', 0],
  ['intents=1<<0 仅 GUILDS', 1 << 0],
  ['intents=1<<30 仅频道@消息', 1 << 30],
  ['intents=1<<25 仅群/单聊消息', 1 << 25],
  ['intents=1<<12 仅私信(频道)', 1 << 12],
  ['intents=1<<26 仅按钮交互', 1 << 26],
  ['intents=全量(当前使用的)', (1 << 0) | (1 << 1) | (1 << 30) | (1 << 12) | (1 << 25) | (1 << 26)],
];

for (const [label, v] of cases) {
  const r = await probe(label, v);
  console.log('  ' + r);
  await new Promise((r2) => setTimeout(r2, 1200));
}
process.exit(0);
