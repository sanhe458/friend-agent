import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRegistry } from './registry.ts';

/**
 * 真·浏览器工具（无头 Chromium，走 CDP，不依赖 playwright）。
 *
 * 「浏览器专员」以前名不副实：白名单里只有 read/bash/edit/... ，
 * 所谓"打开网页"其实只是 curl 静态 HTML —— 不会渲染 JS、不能点击、不能截图。
 * 这个工具把描述里的承诺变成真的。
 *
 * 设计要点：
 * - **一个会话 = 一个 Chromium + 一个页面**（按 personId 分开）：让「打开 → 点击 → 取正文」连贯。
 * - **空闲回收**（默认 3 分钟）+ 进程退出兜底：防进程泄漏（本项目踩过轮询泄漏的坑）。
 * - 点击派发**真实鼠标事件**（Input.dispatchMouseEvent），不是 el.click()。
 * - 关会话时**先 Browser.close 再按进程组 SIGKILL**：Chromium 的 zygote/renderer 是独立子进程，
 *   只杀主进程会留下孤儿。
 *
 * ⚠️ 工具名是 `browse` 不是 `browser` —— `browser` 已被「浏览器专员」占用（按 kind 注册），重名会抛异常。
 */

const IDLE_MS = Number(process.env.BROWSER_IDLE_MS ?? 3 * 60_000);
const BASE_PORT = Number(process.env.BROWSER_DEBUG_PORT ?? 9350);
const PORT_SPAN = 40;          // 端口池：9350..9389
const SHOTS_DIR = process.env.BROWSER_SHOT_DIR ?? join(process.cwd(), 'shots');

interface Session {
  proc: ChildProcess;
  ws: WebSocket;
  port: number;
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();
const launching = new Map<string, Promise<Session>>();
let portSeq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findChrome(): string {
  for (const d of globSync('/root/.cache/ms-playwright/chromium-*')) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = `${d}/${rel}`;
      try { readFileSync(p); return p; } catch { /* 试下一个 */ }
    }
  }
  throw new Error('本机找不到 chromium（/root/.cache/ms-playwright/chromium-*）');
}

/** 把一条 WebSocket 包成「发命令 + 等回应」的小客户端 */
function makeCdp(ws: WebSocket) {
  let msgId = 0;
  const waits = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => {
    let m: any;
    try { m = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (m?.id && waits.has(m.id)) { waits.get(m.id)!(m); waits.delete(m.id); }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((res, rej) => {
      const i = ++msgId;
      waits.set(i, res);
      try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { waits.delete(i); rej(e); }
    });
  return { send, pending: waits };
}

/** 关掉一个会话（幂等）：先优雅关，再按**进程组**兜底杀 */
function closeSession(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(key);
  try { void s.send('Browser.close'); } catch { /* 已经断了 */ }
  try { s.ws.close(); } catch { /* ignore */ }
  // Chromium 的 zygote/renderer 是独立子进程；detached 让它自成进程组，这里整组杀
  try { if (s.proc.pid) process.kill(-s.proc.pid, 'SIGKILL'); } catch { /* ignore */ }
  try { s.proc.kill('SIGKILL'); } catch { /* ignore */ }
}

/** 续命：重置空闲计时器 */
function touch(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => closeSession(key), IDLE_MS);
  s.timer.unref?.();
}

/** 拿一个会话：有且存活就复用；**同一 key 的并发调用共享同一次启动**（否则会开出两个 Chromium） */
function getSession(key: string): Promise<Session> {
  const cur = sessions.get(key);
  if (cur && cur.proc.exitCode === null) { cur.lastUsed = Date.now(); return Promise.resolve(cur); }

  const inflight = launching.get(key);
  if (inflight) return inflight;

  const p = (async (): Promise<Session> => {
    const chrome = findChrome();
    const port = BASE_PORT + (portSeq++ % PORT_SPAN);
    const proc = spawn(chrome, [
      '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox',
      '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,980', 'about:blank',
    ], { stdio: 'ignore', detached: true });

    let wsUrl = '';
    for (let i = 0; i < 40; i++) {
      if (proc.exitCode !== null) break;
      try {
        const j = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl?: string };
        if (j?.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
      } catch { /* 还没起来 */ }
      await sleep(300);
    }
    if (!wsUrl) {
      try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { /* ignore */ }
      throw new Error('chromium 启动失败（端口 ' + port + '）');
    }

    const tab = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });

    const cdp = makeCdp(ws);
    const sess: Session = { proc, ws, port, send: cdp.send, lastUsed: Date.now() };
    // 连接断了要能自愈：把会话清掉，下次重新起
    ws.addEventListener('close', () => { if (sessions.get(key) === sess) sessions.delete(key); });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
    sessions.set(key, sess);
    touch(key);
    return sess;
  })();

  launching.set(key, p);
  void p.catch(() => {}).finally(() => { if (launching.get(key) === p) launching.delete(key); });
  return p;
}

/** 跑一段 JS 并取回值；页面里的异常会变成可读的报错 */
async function evalJs(s: Session, expr: string): Promise<any> {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const ex = r?.result?.exceptionDetails;
  if (ex) throw new Error(String(ex.exception?.description ?? ex.text ?? 'JS 执行出错').split('\n')[0]);
  return r?.result?.result?.value;
}

/** 进程退出时别留孤儿 */
process.once('exit', () => { for (const k of [...sessions.keys()]) closeSession(k); });

export function registerBrowserTool(reg: ToolRegistry): void {
  reg.register({
    name: 'browse',
    description:
      '真浏览器（无头 Chromium）。**能渲染 JS、能点击、能截图**，适合需要交互或 JS 渲染的页面。\n' +
      '用法：先 action=open 打开网址，再 text（取正文）/ snapshot（列出可点击元素）/ click（按 ref 或选择器点）/ screenshot（截图）。\n' +
      '同一会话保持页面状态，所以「打开→点击→再取正文」是连贯的。',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'text', 'snapshot', 'click', 'screenshot', 'url', 'close'] },
        url: { type: 'string', description: 'open 时必填' },
        ref: { type: 'string', description: 'snapshot 给出的元素 ref（如 e3）' },
        selector: { type: 'string', description: '也可用 CSS 选择器代替 ref' },
        maxChars: { type: 'number', description: 'text 返回的最大字符数（默认 4000）' },
        waitMs: { type: 'number', description: 'open/click 后额外等待毫秒' },
      },
      required: ['action'],
    },
    timeoutMs: 30_000,
    run: async (args: { action: string; url?: string; ref?: string; selector?: string; maxChars?: number; waitMs?: number }, ctx) => {
      const key = ctx?.personId || 'default';
      const a = String(args.action || '').toLowerCase();

      if (a === 'close') { closeSession(key); return '已关闭浏览器会话'; }

      const s = await getSession(key);
      try {
        if (a === 'open') {
          if (!args.url) return '✗ open 需要 url';
          const u = /^(https?|data|file|about):/i.test(args.url) ? args.url : 'https://' + args.url;
          const nav = await s.send('Page.navigate', { url: u });
          // ⚠️ 导航失败（DNS 挂了 / 域名打不开）会放在 errorText 里，不能当成功
          const navErr = nav?.result?.errorText;
          if (navErr) return `✗ 打开失败：${navErr}（${u}）`;

          const budget = args.waitMs ?? 2500;
          const t0 = Date.now();
          while (Date.now() - t0 < budget) {
            const st = await evalJs(s, 'document.readyState').catch(() => '');
            if (st === 'complete') break;
            await sleep(250);
          }
          await sleep(Math.min(args.waitMs ?? 800, 3000));
          const title = await evalJs(s, 'document.title').catch(() => '');
          const n = await evalJs(s, 'document.body ? document.body.innerText.length : 0').catch(() => 0);
          return `已打开 ${u}\n标题：${title}\n正文长度：${n} 字符`;
        }

        if (a === 'url') return await evalJs(s, 'location.href').catch(() => '');

        if (a === 'text') {
          const max = args.maxChars ?? 4000;
          const t = await evalJs(s, 'document.body ? document.body.innerText : ""');
          const clean = String(t ?? '').replace(/\n{3,}/g, '\n\n').trim();
          if (!clean) return '（页面没有可见文本；如果内容靠 JS 渲染，试试 waitMs 调大一点）';
          return clean.length > max ? clean.slice(0, max) + `\n…（截断，共 ${clean.length} 字符）` : clean;
        }

        if (a === 'snapshot') {
          const raw = await evalJs(s, `(function(){
            var els = document.querySelectorAll('a,button,input,textarea,select,[role=button],[onclick]');
            var out = [], i = 0;
            for (var k = 0; k < els.length; k++) {
              var el = els[k], r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              var ref = 'e' + (++i);
              el.setAttribute('data-fa-ref', ref);
              out.push({ ref: ref, tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 50),
                type: el.getAttribute('type') || '', name: el.getAttribute('name') || '',
                href: (el.getAttribute('href') || '').slice(0, 80) });
              if (out.length >= 60) break;
            }
            return JSON.stringify(out);
          })()`);
          const list = JSON.parse(raw || '[]') as Array<{ ref: string; tag: string; text: string; type: string; name: string; href: string }>;
          if (!list.length) return '（这一页没有可点击元素）';
          return list.map((e) => `${e.ref}  <${e.tag}${e.type ? ' ' + e.type : ''}>  ${e.text || e.name || ''}${e.href ? '  → ' + e.href : ''}`).join('\n');
        }

        if (a === 'click') {
          const sel = args.ref ? `[data-fa-ref="${String(args.ref).replace(/[^a-zA-Z0-9_-]/g, '')}"]` : String(args.selector || '');
          if (!sel) return '✗ click 需要 ref 或 selector';
          const box = await evalJs(s, `(function(){
            var el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            var r = el.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
              tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 40) });
          })()`);
          if (!box) return `✗ 找不到元素：${sel}（页面可能已经跳转；先用 snapshot 重新看 ref）`;
          const b = JSON.parse(box) as { x: number; y: number; tag: string; text: string };
          await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
          await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          await sleep(args.waitMs ?? 1500);
          const now = await evalJs(s, 'location.href').catch(() => '');
          return `已点击 ${b.tag}「${b.text}」\n当前地址：${now}`;
        }

        if (a === 'screenshot') {
          mkdirSync(SHOTS_DIR, { recursive: true });
          const shot = await s.send('Page.captureScreenshot', { format: 'png' });
          const data = shot?.result?.data;
          if (!data) return '✗ 截图失败';
          const p = join(SHOTS_DIR, `browser-${Date.now()}.png`);
          writeFileSync(p, Buffer.from(data, 'base64'));
          return `已截图：${p}`;
        }

        return `✗ 不认识的 action：${a}（可用：open / text / snapshot / click / screenshot / url / close）`;
      } finally {
        touch(key);
      }
    },
  });
}
