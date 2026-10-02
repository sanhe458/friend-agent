import { createApp } from '/root/.openclaw/workspace/projects/friend-agent/src/app.ts';

const app = createApp();
if (!app.qq) {
  console.log('QQ 通道未挂载（配置里没有 appId/clientSecret）');
  process.exit(1);
}

app.onLog((e) => { if (e.channel === 'qq') console.log('   log>', e.text); });
console.log('等待网关 READY…');

for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = app.qq.status();
  console.log(`[${(i + 1) * 2}s] online=${s.online} gateway=${s.gatewayConnected} session=${s.sessionId ? '有' : '无'} seq=${s.lastSeq} reconnects=${s.reconnects}${s.lastError ? ' err=' + s.lastError : ''}`);
  if (s.online) {
    console.log('\n✅ READY —— 机器人已上线');
    break;
  }
}
app.qq.stop();
process.exit(0);
