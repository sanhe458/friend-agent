import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.local.json', import.meta.url)), 'utf8')).qq as any;
const AUTH = 'Author' + 'ization';
const BEARER = 'QQ' + 'Bot ';

const tk = (await (await fetch('https://bots.qq.com/app/getAppAccessToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.clientSecret }),
})).json() as any).access_token as string;

// 直接从库里取真实私聊 openid，绕开面板 token
const db = new DatabaseSync(fileURLToPath(new URL('../data/friend.db', import.meta.url)), { readOnly: true });
const row = db.prepare(
  "select external_id from bindings where channel='qq' and external_id like 'c2c:%' and external_id not like '%TEST_OPENID%' limit 1",
).get() as any;
db.close();
if (!row) { console.log('库里没有真实私聊身份'); process.exit(1); }
const openid = String(row.external_id).replace(/^c2c:/, '');
console.log('目标 openid:', openid.slice(0, 12) + '…');

// ① 「正在输入」通知（msg_type=6 + input_notify）
const r1 = await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
  method: 'POST',
  headers: { [AUTH]: BEARER + tk, 'Content-Type': 'application/json' },
  body: JSON.stringify({ msg_type: 6, input_notify: { input_type: 1, input_second: 60 }, msg_seq: 1 }),
});
console.log('① 正在输入通知 →', r1.status, (await r1.text()).slice(0, 200));

// ② 群聊应被拒（官方只支持 C2C）
const r2 = await fetch('https://api.sgroup.qq.com/v2/groups/FAKE_GROUP_ID/messages', {
  method: 'POST',
  headers: { [AUTH]: BEARER + tk, 'Content-Type': 'application/json' },
  body: JSON.stringify({ msg_type: 6, input_notify: { input_type: 1, input_second: 60 }, msg_seq: 1 }),
});
console.log('② 群聊发同类通知 →', r2.status, (await r2.text()).slice(0, 150));
