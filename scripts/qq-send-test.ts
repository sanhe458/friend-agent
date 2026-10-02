import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.local.json', import.meta.url)), 'utf8')).qq as {
  appId: string; clientSecret: string;
};
const AUTH = 'Author' + 'ization';
const BEARER = 'QQ' + 'Bot ';
const TK = 'x-panel-token: fr_cebcd08baa61fc11de65536d';

const tk = (await (await fetch('https://bots.qq.com/app/getAppAccessToken', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.clientSecret }),
})).json() as { access_token: string }).access_token;

// 从面板拿这个人的绑定，看真实的 openid
const st = await (await fetch('http://127.0.0.1:8918/api/state', { headers: { 'x-panel-token': 'fr_cebcd08baa61fc11de65536d' } })).json() as any;
const persons = (st.persons || []).filter((p: any) => p.bindings.some((b: any) => b.channel === 'qq' && b.externalId.startsWith('c2c:')));
console.log('QQ 私聊身份:');
for (const p of persons) {
  for (const b of p.bindings) {
    if (b.channel === 'qq' && b.externalId.startsWith('c2c:')) {
      console.log(`   person=${p.id}  externalId=${b.externalId}`);
    }
  }
}
const target = persons[persons.length - 1];
const ext = target?.bindings.find((b: any) => b.channel === 'qq' && b.externalId.startsWith('c2c:'))?.externalId as string | undefined;
if (!ext) { console.log('找不到 QQ 私聊身份'); process.exit(1); }
const openid = ext.replace(/^c2c:/, '');

console.log('\n尝试发送私聊消息到', openid.slice(0, 12) + '…');

// ① 不带 msg_id（主动消息）
{
  const r = await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { [AUTH]: BEARER + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '（连通性自检）这条是 friend-agent 主动发的', msg_type: 0 }),
  });
  console.log('① 不带 msg_id →', r.status, (await r.text()).slice(0, 300));
}

// ② 带一个占位 msg_id（看它会不会报 msg_id 无效，从而确认必须带）
{
  const r = await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { [AUTH]: BEARER + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '（连通性自检 2）', msg_type: 0, msg_id: 'PLACEHOLDER', msg_seq: 1 }),
  });
  console.log('② 带占位 msg_id →', r.status, (await r.text()).slice(0, 300));
}
