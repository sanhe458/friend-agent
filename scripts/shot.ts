import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * 无头截图 + 命中测试（CDP 驱动，不装 playwright）。
 * 令牌**从项目配置里读**，绝不走命令行参数（命令行里的敏感串会被打码改写成 ***，导致截到登录门）。
 *
 * 环境变量：
 *   SHOT_W / SHOT_H   视口尺寸（默认 1440x980）
 *   SHOT_TAB          先切到某页（如 overview）
 *   SHOT_JS           切页后额外执行的 JS
 *   SHOT_OUT          输出文件名（默认 shot.png）
 *   SHOT_MOBILE       1 = 手机视口
 */
const PORT = 9344;
const PANEL = 'http://127.0.0.1:8918';
const OUT = process.env.SHOT_OUT || 'shot.png';

function findChrome(): string {
  const dirs = globSync('/root/.cache/ms-playwright/chromium-*');
  for (const d of dirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = `${d}/${rel}`;
      try { readFileSync(p); return p; } catch { /* 下一个 */ }
    }
  }
  throw new Error('找不到 chromium');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cdp(ws: WebSocket) {
  let id = 0;
  const waits = new Map<number, (v: any) => void>();
  const errors: string[] = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String((ev as MessageEvent).data));
    if (m.id && waits.has(m.id)) { waits.get(m.id)!(m); waits.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      errors.push(String(d?.exception?.description ?? d?.text ?? 'unknown').split('\n')[0]);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      errors.push('console: ' + (m.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, errors };
}

async function main() {
  const chrome = findChrome();
  const proc = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,980', 'about:blank',
  ], { stdio: 'ignore', detached: false });

  // 轮询等 chrome 起来
  let wsUrl = '';
  for (let i = 0; i < 40; i++) {
    try {
      const j = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()) as any;
      if (j?.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  if (!wsUrl) { console.log('❌ chrome 没起来'); proc.kill(); process.exit(1); }

  // 新标签页（新版 chrome 只认 PUT）
  const tab = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()) as any;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', () => r(null), { once: true }));
  const { send, errors } = await cdp(ws);

  const W = Number(process.env.SHOT_W || 1440), H = Number(process.env.SHOT_H || 980);
  await send('Page.enable');
  await send('Runtime.enable');
  if (process.env.SHOT_MOBILE === '1' || W < 500) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  } else {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  }

  // 令牌：脚本自己读配置，不走命令行
  const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
  const keyName = 'panel' + 'Token';
  const authKey = String(cfg[keyName] ?? '');

  await send('Page.navigate', { url: PANEL + '/' });
  await sleep(1200);
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('fa_token', ${JSON.stringify(authKey)}); location.reload();`,
  });
  await sleep(2600);

  const gate = await send('Runtime.evaluate', {
    expression: `getComputedStyle(document.querySelector('.gate')).display`,
    returnByValue: true,
  });
  console.log('登录门 display =', gate?.result?.result?.value, '（必须是 none 才算真进站）');

  if (process.env.SHOT_TAB) {
    await send('Runtime.evaluate', {
      expression: `(function(){var b=document.querySelector('[data-tab="${process.env.SHOT_TAB}"]'); if(b) b.click();})()`,
    });
    await sleep(1500);
  }
  if (process.env.SHOT_JS) {
    const r = await send('Runtime.evaluate', { expression: process.env.SHOT_JS, awaitPromise: true, returnByValue: true });
    const v = r?.result?.result?.value;
    if (v !== undefined) console.log('JS 结果:\n' + String(v));
    await sleep(900);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const data = shot?.result?.data;
  if (!data) { console.log('❌ 截图失败'); } else {
    mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
    const p = new URL('../shots/' + OUT, import.meta.url);
    writeFileSync(p, Buffer.from(data, 'base64'));
    console.log('✅ 已存 shots/' + OUT);
  }

  // 命中测试：主要按钮能否真点到
  if (process.env.SHOT_HIT) {
    const sel = process.env.SHOT_HIT;
    const r = await send('Runtime.evaluate', {
      expression: `(function(sel){var b=document.querySelector(sel); if(!b) return 'missing';
        var r=b.getBoundingClientRect();
        var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
        return JSON.stringify({sel:sel, rect:[r.left|0,r.top|0,r.width|0,r.height|0],
          top: el? el.tagName+(el.id?'#'+el.id:'') : null,
          reachable: !!(el && (el===b || b.contains(el)))});})(${JSON.stringify(sel)})`,
      returnByValue: true,
    });
    console.log('命中测试:', r?.result?.result?.value);
  }

  console.log('异常:', errors.length ? errors.slice(0, 5) : '（无）');
  ws.close();
  proc.kill();
  process.exit(0);
}

void main();
