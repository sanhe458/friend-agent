import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function findChrome(): string | null {
  const base = '/root/.cache/ms-playwright';
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    for (const p of [
      join(base, d, 'chrome-linux64', 'chrome'),
      join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    ]) if (existsSync(p)) return p;
  }
  return null;
}
const bin = findChrome();
if (!bin) { console.log('没找到 chromium'); process.exit(1); }

const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
const TOKEN = String(cfg['panel' + 'Token'] || '');
console.log('令牌长度:', TOKEN.length);

const PORT = 9344;
const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
  '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,980', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let browserWs = '';
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { browserWs = (await r.json()).webSocketDebuggerUrl; break; } } catch {}
  await sleep(300);
}
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json() as any;
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map<number, (v: any) => void>();
const errors: string[] = [];
ws.addEventListener('message', (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push('EXCEPTION: ' + (d.exception?.description || d.text || '').split('\n').slice(0, 3).join(' | '));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const cmd = (method: string, params: any = {}) => new Promise<any>((res) => { const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
const evalJs = async (expr: string) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await cmd('Page.enable'); await cmd('Runtime.enable');

// 视口（默认桌面；传 SHOT_W/H 则模拟手机）
const VW = Number(process.env.SHOT_W || 0);
const VH = Number(process.env.SHOT_H || 0);
if (VW && VH) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: true });
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true });
  console.log(`视口: ${VW}x${VH} (手机)`);
}

await cmd('Page.navigate', { url: 'http://127.0.0.1:8918/' });
await sleep(1200);
await cmd('Runtime.evaluate', { expression: `localStorage.setItem('fa_token', ${JSON.stringify(TOKEN)})` });
await cmd('Page.reload', {});
await sleep(2600);

console.log('=== 初载后异常 ===');
console.log(errors.length ? errors.map((e) => '  ' + e).join('\n') : '  （无）');

// 全局：脚本是否完整执行到末尾（看 boot 是否跑过、ST 是否有值）
console.log('\n=== 关键状态 ===');
console.log('  ST 已加载 :', await evalJs('typeof ST !== "undefined" && !!ST'));
console.log('  api 函数  :', await evalJs('typeof api'));
console.log('  openDlg   :', await evalJs('typeof openDlg'));
console.log('  登录墙隐藏:', await evalJs('getComputedStyle(document.querySelector(".gate")).display'));

// 逐个 tab 遍历，看有没有渲染时抛异常
const tabs = ['overview', 'persons', 'memory', 'channels', 'models', 'mcp', 'roles', 'tools', 'logs', 'search', 'runtime', 'tasks', 'scheduled', 'chat', 'personas'];
console.log('\n=== 逐页切换 ===');
for (const t of tabs) {
  const before = errors.length;
  await evalJs(`(function(){var b=document.querySelector('[data-tab="${t}"]'); if(b) b.click();})()`);
  await sleep(1100);
  const navOn = await evalJs(`document.querySelectorAll('#nav button.on').length`);
  const htmlLen = await evalJs(`document.getElementById('view').innerHTML.length`);
  const acts = await evalJs(`document.querySelectorAll('#view [data-act]').length`);
  console.log(`  ${t.padEnd(10)} 高亮=${navOn} 内容长度=${String(htmlLen).padStart(6)} 可点按钮=${acts} 新异常=${errors.length - before}`);
}
console.log('\n=== 全部异常 ===');
console.log(errors.length ? errors.map((e) => '  ' + e).join('\n') : '  （无）');

// 直接测一次弹窗：点模型页的编辑按钮
console.log('\n=== 交互测试：点开「编辑」弹窗 ===');
await evalJs(`(function(){var b=document.querySelector('[data-tab="models"]'); if(b) b.click();})()`);
await sleep(1500);
const clicked = await evalJs(`(function(){var b=document.querySelector('#view [data-act="pv-edit"]'); if(!b) return 'no-button'; b.click(); return 'clicked';})()`);
await sleep(600);
console.log('  点击结果:', clicked);
console.log('  弹窗可见:', await evalJs(`document.querySelector('.mask') ? getComputedStyle(document.querySelector('.mask')).display : 'no-mask'`));
console.log('  弹窗标题:', await evalJs(`document.querySelector('#dlg-t') ? document.querySelector('#dlg-t').textContent : '-'`));
console.log('  异常:', errors.length ? errors.slice(-3) : '（无）');

// 手机：走一遍抽屉 → 切页 → 点编辑
if (VW) {
  console.log('\n=== 手机交互：汉堡 → 切页 → 编辑 ===');
  await evalJs(`(function(){var h=document.getElementById('hamb'); if(h) h.click();})()`);
  await sleep(700);
  console.log('  抽屉已打开 :', await evalJs(`document.querySelector('.side').classList.contains('open')`));
  console.log('  遮罩已显示 :', await evalJs(`getComputedStyle(document.getElementById('sback')).display`));
  await evalJs(`(function(){var b=document.querySelector('[data-tab="channels"]'); if(b) b.click();})()`);
  await sleep(1100);
  console.log('  切页后抽屉关 :', await evalJs(`document.querySelector('.side').classList.contains('open')`));
  console.log('  遮罩已隐藏 :', await evalJs(`getComputedStyle(document.getElementById('sback')).display`));
  console.log('  遮罩会拦点击 :', await evalJs(`(function(){var r=document.getElementById('sback').getBoundingClientRect(); return r.width>0 && r.height>0;})()`));
  const mb = await evalJs(`(function(){var b=document.getElementById('ch-edit'); if(!b) return 'no-button'; b.click(); return 'clicked';})()`);
  await sleep(700);
  console.log('  点「编辑凭据」:', mb);
  console.log('  弹窗可见   :', await evalJs(`getComputedStyle(document.querySelector('.mask')).display`));
  console.log('  弹窗标题   :', await evalJs(`document.querySelector('#dlg-t').textContent`));
  console.log('  新异常     :', errors.length ? errors.slice(-3) : '（无）');

  // ⚠️ 关键：真实命中测试。element.click() 会绕过遮挡，真手指不会。
  console.log('\n=== 命中测试（谁真正在最上层）===');
  const hit = `(function(sel){
    var g=document.querySelector('.gate'); var gateShown = g ? getComputedStyle(g).display : 'none';
    var b=document.querySelector(sel); if(!b) return JSON.stringify({sel:sel, missing:true, gate:gateShown});
    var r=b.getBoundingClientRect();
    var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    return JSON.stringify({sel:sel, gate:gateShown, rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], top: el? (el.tagName+(el.id?'#'+el.id:'')+(el.className&&typeof el.className==='string'?'.'+el.className.split(' ')[0]:'')) : null, reachable: b.contains(el) || b===el});
  })`;
  console.log('  关闭弹窗先:', await evalJs(`(function(){var m=document.querySelector('.mask'); if(m) m.classList.remove('on'); return 'ok';})()`));
  await sleep(400);
  for (const sel of ['#hamb', '#ch-edit', '.hamb']) {
    console.log('  ' + await evalJs(`${hit}(${JSON.stringify(sel)})`));
  }
  await evalJs(`(function(){var b=document.querySelector('[data-tab="models"]'); if(b) b.click();})()`);
  await sleep(1200);
  console.log('  ' + await evalJs(`${hit}('[data-act="pv-edit"]')`));
  console.log('  ' + await evalJs(`${hit}('[data-act="md-test"]')`));

  // 角色页：下拉是否预填（之前读不存在的 GET /api/roles，永远空）
  await evalJs(`(function(){var b=document.querySelector('[data-tab="roles"]'); if(b) b.click();})()`);
  await sleep(1400);
  console.log('\n=== 角色配置下拉 ===');
  for (const k of ['reply', 'main', 'sub']) {
    console.log('  ' + k.padEnd(6) + await evalJs(`(function(){var s=document.getElementById('rl-${k}'); if(!s) return 'no-select'; return JSON.stringify({tag:s.tagName, options:s.options.length, value:s.value});})()`));
  }
  console.log('  原始角色值: ' + await evalJs(`JSON.stringify((ST.state&&0)||0)`));

  // 滚动：能不能滑到底（手机 100vh 坑的判据）
  console.log('\n=== URL 路由测试 ===');
  console.log('  异常横幅元素存在: ' + await evalJs(`!!document.getElementById('jserr')`));
  console.log('  横幅默认隐藏    : ' + await evalJs(`document.getElementById('jserr') ? getComputedStyle(document.getElementById('jserr')).display : 'missing'`));
  await evalJs(`location.hash = '#/roles'`);
  await sleep(900);
  console.log('  直达 #/roles     : 标题=' + await evalJs(`document.getElementById('ttl').textContent`) + ' 高亮=' + await evalJs(`(document.querySelector('#nav button.on')||{}).textContent`));
  await evalJs(`(function(){var b=document.querySelector('[data-tab="models"]'); if(b) b.click();})()`);
  await sleep(500);
  console.log('  点导航后 hash    : ' + await evalJs(`location.hash`));
  await evalJs(`history.back()`);
  await sleep(700);
  console.log('  浏览器后退       : 标题=' + await evalJs(`document.getElementById('ttl').textContent`) + ' hash=' + await evalJs(`location.hash`));

  console.log('\n=== 错误横幅过滤（只报自家脚本）===');
  await evalJs(`window.dispatchEvent(new ErrorEvent('error', {message:'axios is not defined', filename:'userscript.html?name=New-Userscript.user.js', lineno:126}))`);
  await sleep(300);
  console.log('  油猴脚本报错 → 横幅: ' + await evalJs(`getComputedStyle(document.getElementById('jserr')).display`) + '（期望 none）');
  await evalJs(`window.dispatchEvent(new ErrorEvent('error', {message:'测试异常', filename:location.origin + '/panel/pages/overview.js', lineno:10}))`);
  await sleep(300);
  console.log('  自家脚本报错 → 横幅: ' + await evalJs(`getComputedStyle(document.getElementById('jserr')).display`) + '（期望 block）');
  console.log('  横幅内容: ' + await evalJs(`document.getElementById('jserr').textContent.slice(0,80)`));
  await evalJs(`document.getElementById('jserr').click()`);
  await sleep(200);
  console.log('  点击后可关闭: ' + await evalJs(`getComputedStyle(document.getElementById('jserr')).display`) + '（期望 none）');

  // 服务商按钮（三河报过“新增服务商打不开”：它没有 data-act，所以一直没人绑）
  console.log('\n=== 服务商按钮 ===');
  await evalJs(`(function(){var b=document.querySelector('[data-tab="models"]'); if(b) b.click();})()`);
  await sleep(1400);
  console.log('  新增服务商 reachable: ' + await evalJs(`${hit}('#pv-add')`));
  const pvClick = await evalJs(`(function(){var b=document.getElementById('pv-add'); if(!b) return 'no-button'; b.click(); return 'clicked';})()`);
  await sleep(600);
  console.log('  点击 → ' + pvClick + ' | 弹窗=' + await evalJs(`getComputedStyle(document.querySelector('.mask')).display`) + ' | 标题=' + await evalJs(`document.querySelector('#dlg-t').textContent`));
  await evalJs(`(function(){var m=document.querySelector('.mask'); if(m) m.classList.remove('on');})()`);
  await sleep(250);
  const imClick = await evalJs(`(function(){var b=document.getElementById('pv-import'); if(!b) return 'no-button'; b.click(); return 'clicked';})()`);
  await sleep(1500);
  console.log('  导入 → ' + imClick + ' | 弹窗=' + await evalJs(`getComputedStyle(document.querySelector('.mask')).display`) + ' | 标题=' + await evalJs(`document.querySelector('#dlg-t').textContent`));

  // 滚动：能不能滑到底（手机 100vh 坑的判据）
  console.log('\n=== 滚动到底测试 ===');
  console.log('  ' + await evalJs(`(function(){
    var b=document.querySelector('.body'); if(!b) return 'no-body';
    b.scrollTop = 999999;
    var r={sh:b.scrollHeight, ch:b.clientHeight, st:Math.round(b.scrollTop), reached:(b.scrollTop+b.clientHeight)>=(b.scrollHeight-2)};
    return JSON.stringify(r);
  })()`));
  // 顶部第一张卡片的 y 坐标（滑到底后应仍在视口内可见区）
  console.log('  底部元素可见性: ' + await evalJs(`(function(){
    var v=document.querySelectorAll('#view .card, #view table tr');
    if(!v.length) return 'empty';
    var last=v[v.length-1].getBoundingClientRect();
    return JSON.stringify({lastBottom:Math.round(last.bottom), innerH:window.innerHeight, visible: last.bottom <= window.innerHeight+2});
  })()`));
}

ws.close(); proc.kill();
process.exit(0);
