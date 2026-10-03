/* 面板外壳：工具函数 / 路由 / 导航 / 弹窗 / 快照刷新 */
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'fa_token';
let ST = null, TAB = 'overview';

/* ── 全局异常可见化 ──────────────────────
   否则“按钮点了没反应”只能靠猜是哪儿抛的。
   ⚠️ 只报“本面板自己的”脚本：页面上还跑着浏览器插件/油猴脚本（userscript）
   的代码，它们的报错不是面板的问题，混进来只会淹没真问题。 */
function isOwnScript(file) {
  const f = String(file || '');
  if (!f) return true; // 同页内联
  try {
    const u = new URL(f, location.href);
    return u.origin === location.origin && u.pathname.indexOf('/panel/') === 0;
  } catch (e) { return false; }
}
function showJsErr(msg) {
  const el = document.getElementById('jserr');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + '[JS] ' + msg;
}
window.addEventListener('error', (e) => {
  if (!isOwnScript(String(e.filename || ''))) {
    console.warn('[panel] 已忽略外部脚本的报错（不是面板的问题）：', e.filename, e.message);
    return;
  }
  showJsErr((e.message || 'error') + '  @ ' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const stack = String((r && (r.stack || r.message)) || '');
  // 堆栈里能看出是插件/油猴时不弹（它们常驻页面，报错与面板无关）
  if (/userscript\.html|chrome-extension:\/\/|moz-extension:\/\//.test(stack)) return;
  showJsErr('Promise 未捕获：' + ((r && (r.message || r)) || ''));
});

/* 横幅可点掉（否则一直挂在底部挡视线） */
(function initBanner() {
  const el = document.getElementById('jserr');
  if (!el) return;
  el.title = '点击关闭';
  el.addEventListener('click', () => { el.style.display = 'none'; el.textContent = ''; });
})();

function getToken() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
function authHeaders(extra) { const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {}); h['x-panel-' + 'token'] = getToken(); return h; }

async function api(path) {
  const r = await fetch(path, { headers: authHeaders() });
  if (r.status === 401) { $('#gate').style.display = 'flex'; return { error: 'unauthorized' }; }
  try { return await r.json(); } catch (e) { return { error: 'bad json' }; }
}
async function send(path, body) {
  const r = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) });
  try { return await r.json(); } catch (e) { return { error: 'bad json' }; }
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ── 弹窗 ─────────────────────────────── */
/* 弹窗同一时刻只允许一个「确定」在飞：否则连点两下会发两次请求
   （新增服务商/模型时会各写一份配置）。 */
let dlgBusy = false;
function openDlg(title, bodyHtml, okLabel, onOk) {
  $('#dlg-t').textContent = title;
  $('#dlg-b').innerHTML = bodyHtml;
  const f = $('#dlg-f'); f.innerHTML = '';
  const cancel = document.createElement('button');
  cancel.className = 'btn'; cancel.textContent = '取消';
  cancel.addEventListener('click', closeDlg);
  f.appendChild(cancel);
  if (onOk) {
    const ok = document.createElement('button');
    ok.className = 'btn pri'; ok.textContent = okLabel || '保存';
    ok.addEventListener('click', async () => {
      if (dlgBusy) return; // 已在提交中，忽略重复点击
      dlgBusy = true; ok.disabled = true;
      let done = false;
      try {
        const r = await onOk();
        done = r !== false;
      } catch (e) {
        // onOk 自己没兜住的异常，别把弹窗卡在禁用态
        console.error('[dlg]', e);
        if (typeof toast === 'function') toast('✗ ' + ((e && e.message) || '操作失败'));
      } finally {
        dlgBusy = false;
        ok.disabled = false;
      }
      // 先解除 busy 再关，否则 closeDlg 的提交中保护会把合法关闭挡掉
      if (done && $('#mask').classList.contains('on')) closeDlg();
    });
    f.appendChild(ok);
  }
  $('#mask').classList.add('on');
}
function closeDlg() {
  if (dlgBusy) return; // 提交中不许关，避免「界面关了但请求已发出」的半截状态
  $('#mask').classList.remove('on');
  $('#dlg-b').innerHTML = ''; // 清掉表单，防止残留 input 的 id 被后续 querySelector 误命中
}
$('#mask').addEventListener('click', (e) => { if (e.target === $('#mask')) closeDlg(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDlg(); });

/* ── 导航 ─────────────────────────────── */
/* 导航图标：内联 SVG 线性图标（自包含，不引 CDN；不用 emoji）
   原来是一堆 ▣◍◈◔☺❑◉◆◇☯⚙≡ 几何字符，看着像占位符。 */
const ICO = {
  overview: '<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/>',
  chat: '<path d="M20.5 11.5a8 8 0 0 1-11.8 7L4 20l1.6-4.5A8 8 0 1 1 20.5 11.5z"/>',
  tasks: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  scheduled: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  persons: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c0-4 3.4-6 7.5-6s7.5 2 7.5 6"/>',
  memory: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  channels: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4L11.6 6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0L5 12.6a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  models: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
  roles: '<path d="M4 8h9M19 8h1M4 16h3M13 16h7"/><circle cx="16" cy="8" r="2.2"/><circle cx="10" cy="16" r="2.2"/>',
  personas: '<path d="M4.5 5.5h15v5.5a7.5 7.5 0 0 1-15 0z"/><path d="M9 10.5h.02M15 10.5h.02"/>',
  tools: '<path d="M15.5 4a4.5 4.5 0 0 0-3.9 6.7L4 18.3 5.7 20l7.6-7.6A4.5 4.5 0 0 0 20 8.5l-3 3-2.5-2.5 3-3A4.5 4.5 0 0 0 15.5 4z"/>',
  logs: '<path d="M6 3.5h8l4.5 4.5v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12h6M9 15.5h6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  runtime: '<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>',
};
function icoSvg(id) {
  const p = ICO[id];
  if (!p) return '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
    + 'stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}

const NAV = [
  { grp: '运行' },
  { id: 'overview', ico: '▣', label: '概览' },
  { id: 'chat', ico: '◍', label: '对话' },
  { id: 'tasks', ico: '◈', label: '任务' },
  { id: 'scheduled', ico: '◔', label: '定时任务' },
  { grp: '对象' },
  { id: 'persons', ico: '☺', label: '人 / 身份' },
  { id: 'memory', ico: '❑', label: '记忆' },
  { grp: '配置' },
  { id: 'channels', ico: '◉', label: '通道' },
  { id: 'models', ico: '◆', label: '模型与服务商' },
  { id: 'mcp', ico: '⛭', label: 'MCP' },
  { id: 'roles', ico: '◇', label: '角色与策略' },
  { id: 'personas', ico: '☯', label: '人格预设' },
  { id: 'tools', ico: '⚙', label: '工具白名单' },
  { grp: '诊断' },
  { id: 'logs', ico: '≡', label: '日志' },
  { id: 'search', ico: '⌕', label: '搜索' },
  { id: 'runtime', ico: '↻', label: '运行时' }
];
const TITLES = {
  overview: ['概览', '整体运行状态'], chat: ['对话', '查看与某人正在进行的会话'],
  tasks: ['任务', '后台子 agent 的进度'], persons: ['人 / 身份', '跨通道识别与归并'],
  memory: ['记忆', '每个人独立保存的事实与偏好'], channels: ['通道', '平台适配器与 QQ 官方机器人'],
  models: ['模型与服务商', '模型角色映射与连通性'], roles: ['角色与策略', '每个角色用哪个模型'],
  tools: ['工具白名单', '前台与子 agent 可用的工具'], logs: ['日志', '与各通道的收发记录'],
  search: ['搜索', '秘塔联网检索'], runtime: ['运行时', '热重载与进程重启'],
  scheduled: ['定时任务', '到点主动找他说话'],
  personas: ['人格预设', '一个 agent，多套人格，按对话切换']
};
function renderNav() {
  const n = $('#nav');
  n.innerHTML = NAV.map((x) => x.grp
    ? '<div class="grp">' + esc(x.grp) + '</div>'
    : '<button data-tab="' + x.id + '"' + (x.id === TAB ? ' class="on"' : '') + '><i class="ico">' + icoSvg(x.id) + '</i>' + esc(x.label) + '</button>'
  ).join('');
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.getAttribute('data-tab'))));
}
function closeSide() { const s = $('.side'); if (s) s.classList.remove('open'); const b = $('#sback'); if (b) b.classList.remove('on'); }

/* ── 路由（每个页面一个 URL：#/models 之类，可收藏可直达）── */
const PAGES = {};
const HASH_PREFIX = '#/';
function tabFromHash() {
  const h = String(location.hash || '').replace(/^#\/?/, '');
  return TITLES[h] ? h : 'overview';
}
function go(id, keepHash) {
  if (!TITLES[id]) return;
  TAB = id;
  if (!keepHash) {
    const want = HASH_PREFIX + id;
    if (location.hash !== want) location.hash = want; // 记录历史 + 会触发 hashchange
  }
  paint(); // 立即画，不等 hashchange（否则有可见的“点了没反应”时间窗）
}
let paintedTab = '';
function paint() {
  renderNav();
  $('#ttl').textContent = TITLES[TAB][0];
  $('#tsub').textContent = TITLES[TAB][1];
  closeSide();
  if (paintedTab !== TAB) { const bd = $('.body'); if (bd) bd.scrollTop = 0; paintedTab = TAB; }
  render();
}
window.addEventListener('hashchange', () => {
  const id = tabFromHash();
  if (id !== TAB) { TAB = id; paint(); }   // go() 已经画过则 TAB 相同，跳过重复渲染
});

/* 路由：按页面 id 从注册表派发（新增页面 = 新增一个 pages/<id>.js） */
function render() {
  const v = $('#view');
  const t = $('#tacts');
  if (t) t.innerHTML = '';
  // ⚠️ 快照还没到手时（登录前 / 首次加载中）不能派发到页面，否则各页会读空 ST 抛错。
  //    —— 但要注意：`lastSig` 也**不能**在这里更新。以前在这里就写了 lastSig，
  //    而真实数据到达前 signature() 基于空 ST 恒为同一个值；等 refresh() 拿到数据再比对时
  //    「空签名 === 记下的空签名」→ 判定"没变化"→ 永远不再重画，页面白屏（必现）。
  if (!ST) { v.innerHTML = '<div class="empty">加载中…</div>'; return; }
  lastSig = signature();
  lastTab = TAB;
  const pg = PAGES[TAB];
  if (pg && typeof pg.render === 'function') return pg.render(v);
  v.innerHTML = '<div class="empty">页面「' + esc(TAB) + '」还没实现</div>';
}

/* ── 无缝刷新：数据没变就不重画（避免整屏闪、输入框被清空）── */
let lastSig = '', lastTab = '';
function signature() {
  const s = (ST && ST.state) || {}, r = (ST && ST.runtime) || {}, q = ((ST && ST.qq) || {}).status || {};
  return [
    (s.log || []).length,
    (s.persons || []).length,
    (s.tasks || []).map((t) => t.status + (t.progress || 0)).join(','),
    r.runningTurns || 0,
    r.reloadCount || 0,
    q.online ? 1 : 0,
    JSON.stringify((ST && ST.memCount) || {}),
  ].join('|');
}

async function refresh() {
  const [state, runtime, qq] = await Promise.all([api('/api/state'), api('/api/runtime'), api('/api/qq')]);
  // 即使是错误响应也要把 ST 建起来，页面才不至于读空 ST
  ST = { state: state || {}, runtime: runtime || {}, qq: qq || {} };
  if (state && state.error) { $('#gate').style.display = 'flex'; render(); return; }
  $('#gate').style.display = 'none';
  // ⚠️ 以前这里对每个人**再串行请求一次 /api/chat** 只为数记忆条数 ——
  //    每人一次重请求（要拉完整事件流+记忆+任务），人一多面板就明显卡。
  //    /api/state 已经带了 memoryCount，直接用它。
  const memCount = {};
  for (const p of (ST.state.persons || [])) memCount[p.id] = p.memoryCount || 0;
  ST.memCount = memCount;
  const rt = ST.runtime;
  $('#sf-pid').textContent = rt.pid || '—';
  const up = Math.floor((rt.uptimeMs || 0) / 1000);
  $('#sf-up').textContent = Math.floor(up / 60) + 'm' + (up % 60) + 's';
  const qqS = (ST.qq && ST.qq.status) || {};
  $('#sf-dot').innerHTML = '<i class="dot ' + (qqS.online ? 'ok' : (rt.persons ? 'busy' : 'off')) + '"></i> ' +
    (qqS.online ? '在线' : (rt.watching ? '就绪' : '未监听'));
  if (signature() !== lastSig || TAB !== lastTab) render();
}

setInterval(() => { if (TAB === 'chat') tickChat(); }, 1200);
setInterval(renderLogsIfOpen, 3000);
let lastLogLen = -1;
function renderLogsIfOpen() {
  if (TAB !== 'logs') return;
  const n = ((ST && ST.state && ST.state.log) || []).length;
  if (n === lastLogLen) return;          // 没新增就不重画，免得日志页每 3 秒闪一下
  lastLogLen = n;
  renderLogs($('#view'));
}

/* ── 启动 ─────────────────────────────── */
$('#hamb').addEventListener('click', () => {
  $('.side').classList.toggle('open');
  $('#sback').classList.toggle('on');
});
$('#sback').addEventListener('click', closeSide);

$('#gate-btn').addEventListener('click', () => {
  localStorage.setItem(KEY, $('#gate-input').value.trim());
  $('#gate').style.display = 'none';
  refresh();
});
renderNav();

/* 带已存令牌回来的用户不该再撞登录墙；令牌失效时 api() 会重新拉起。
   ⚠️ 由 boot.js 在所有页面脚本加载完之后调用（否则 PAGES 还是空的）。 */
async function boot() {
  $('#gate').style.display = getToken() ? 'none' : 'flex';
  await refresh();
  const id = tabFromHash();
  if (id !== TAB) { TAB = id; }
  if (ST) paint();
}
