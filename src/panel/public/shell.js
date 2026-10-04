/* 面板外壳：工具函数 / 路由 / 导航 / 弹窗 / 快照刷新 / 快速跳转 */
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
  if (r.status === 401) { showGate('令牌无效或未提供，请重新输入'); return { error: 'unauthorized' }; }
  try { return await r.json(); } catch (e) { return { error: 'bad json' }; }
}
async function send(path, body) {
  const r = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) });
  if (r.status === 401) { showGate('令牌无效或未提供，请重新输入'); return { error: 'unauthorized' }; }
  try { return await r.json(); } catch (e) { return { error: 'bad json' }; }
}

/* ── 通用格式化 ───────────────────────── */
/** 运行时长：43s → 12m03s → 3h12m → 2d4h（不出现「1847m」这种没法读的数） */
function fmtUptime(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd' + (h % 24) + 'h';
}
/** 相对时间：刚才 / 3m 前 / 2h 前 / 5d 前 / 具体日期 */
function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 0) return '刚刚';
  if (d < 45e3) return '刚刚';
  if (d < 3600e3) return Math.round(d / 60e3) + 'm 前';
  if (d < 86400e3) return Math.round(d / 3600e3) + 'h 前';
  if (d < 7 * 86400e3) return Math.round(d / 86400e3) + 'd 前';
  return new Date(ts).toLocaleDateString('zh-CN');
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const fmtDateTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';

/* ── toast：三态（默认 / ok / err）──────── */
let toastTimer;
function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('ok', 'err');
  if (type === 'ok' || type === 'err') t.classList.add(type);
  t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), type === 'err' ? 3600 : 2200);
}

/* ── 登录墙 ───────────────────────────── */
function showGate(errText) {
  const g = $('#gate');
  g.style.display = 'flex';
  const e = $('#gate-err');
  if (e && errText) { e.textContent = errText; e.style.display = 'block'; }
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
      dlgBusy = true; ok.disabled = true; ok.textContent = '提交中…';
      let done = false;
      try {
        const r = await onOk();
        done = r !== false;
      } catch (e) {
        // onOk 自己没兜住的异常，别把弹窗卡在禁用态
        console.error('[dlg]', e);
        if (typeof toast === 'function') toast('✗ ' + ((e && e.message) || '操作失败'), 'err');
      } finally {
        dlgBusy = false;
        ok.disabled = false; ok.textContent = okLabel || '保存';
      }
      // 先解除 busy 再关，否则 closeDlg 的提交中保护会把合法关闭挡掉
      if (done && $('#mask').classList.contains('on')) closeDlg();
    });
    f.appendChild(ok);
  }
  $('#mask').classList.add('on');
  // 打开弹窗后自动聚焦第一个输入框，减少一次点击
  const first = $('#dlg-b input, #dlg-b select, #dlg-b textarea');
  if (first) setTimeout(() => { try { first.focus(); } catch { /* ignore */ } }, 60);
}
function closeDlg() {
  if (dlgBusy) return; // 提交中不许关，避免「界面关了但请求已发出」的半截状态
  $('#mask').classList.remove('on');
  $('#dlg-b').innerHTML = ''; // 清掉表单，防止残留 input 的 id 被后续 querySelector 误命中
}
$('#mask').addEventListener('click', (e) => { if (e.target === $('#mask')) closeDlg(); });

/* ── 快速跳转（Ctrl / Cmd + K）──────────── */
const paletteEl = $('#palette');
let paletteSel = 0;
function paletteOpen() {
  paletteEl.classList.add('on');
  const q = $('#palette-q');
  q.value = '';
  paletteBuild('');
  setTimeout(() => { try { q.focus(); } catch { /* ignore */ } }, 40);
}
function paletteClose() { paletteEl.classList.remove('on'); }
function paletteItems() {
  const pages = NAV.filter((x) => x.id).map((x) => ({
    kind: 'page', id: x.id, label: x.label, sub: (TITLES[x.id] || [])[1] || '', go: () => go(x.id),
  }));
  const people = (ST && ST.state && ST.state.persons || []).flatMap((p) => (p.bindings || []).map((b) => ({
    kind: 'chat', id: p.id, label: p.displayName || p.id, sub: '对话 · ' + b.channel + ':' + String(b.externalId).slice(0, 18),
    go: () => { location.hash = '#/chat'; TAB = 'chat'; paint(); setTimeout(() => {
      // chat 页渲染后自动选中这个对象
      const sel = document.getElementById('c-person'); if (sel) {
        const v = b.channel + '|' + b.externalId;
        if ([...sel.options].some((o) => o.value === v)) { sel.value = v; sel.dispatchEvent(new Event('change')); }
        else { const ci = document.getElementById('c-id'); if (ci) { ci.value = b.externalId; const cc = document.getElementById('c-ch'); if (cc) cc.value = b.channel; } const ob = document.getElementById('c-open'); if (ob) ob.click(); }
      }
    }, 350); },
  })));
  return pages.concat(people);
}
function paletteBuild(qs) {
  const q = qs.trim().toLowerCase();
  const items = paletteItems().filter((x) => !q || (x.label + ' ' + x.sub + ' ' + x.id).toLowerCase().includes(q)).slice(0, 12);
  paletteSel = 0;
  const list = $('#palette-list');
  list.innerHTML = items.length ? items.map((x, i) =>
    '<div class="pi' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
      '<span class="k">' + (x.kind === 'page' ? '页' : '人') + '</span>' +
      '<b>' + esc(x.label) + '</b><span class="s">' + esc(x.sub) + '</span>' +
    '</div>').join('')
    : '<div class="pi none">没有匹配项</div>';
  const _items = items;
  $$('#palette-list .pi').forEach((el) => {
    if (el.classList.contains('none')) return;
    el.addEventListener('click', () => { const it = _items[Number(el.getAttribute('data-i'))]; paletteClose(); it.go(); });
  });
  $('#palette-q')._items = _items;
}
function paletteMove(delta) {
  const rows = $$('#palette-list .pi:not(.none)');
  if (!rows.length) return;
  paletteSel = (paletteSel + delta + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle('sel', i === paletteSel));
  rows[paletteSel].scrollIntoView({ block: 'nearest' });
}
$('#palette-q').addEventListener('input', (e) => paletteBuild(e.target.value));
$('#palette-q').addEventListener('keydown', (e) => {
  const items = e.target._items || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const rows = $$('#palette-list .pi:not(.none)');
    const it = items[paletteSel] || (rows[0] ? items[0] : null);
    if (it) { paletteClose(); it.go(); }
  }
});
paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) paletteClose(); });

/* ── 导航 ─────────────────────────────── */
/* 导航图标：内联 SVG 线性图标（自包含，不引 CDN；不用 emoji） */
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
  mcp: '<rect x="3.5" y="9.5" width="7" height="5" rx="2.5"/><rect x="13.5" y="9.5" width="7" height="5" rx="2.5"/><path d="M10.5 12h3"/>',
  logs: '<path d="M6 3.5h8l4.5 4.5v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12h6M9 15.5h6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  runtime: '<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4L5.5 5.5"/>',
};
function icoSvg(id) {
  const p = ICO[id];
  if (!p) return '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
    + 'stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}

const NAV = [
  { grp: '运行' },
  { id: 'overview', label: '概览' },
  { id: 'chat', label: '对话' },
  { id: 'tasks', label: '任务' },
  { id: 'scheduled', label: '定时任务' },
  { grp: '对象' },
  { id: 'persons', label: '人 / 身份' },
  { id: 'memory', label: '记忆' },
  { grp: '配置' },
  { id: 'channels', label: '通道' },
  { id: 'models', label: '模型与服务商' },
  { id: 'mcp', label: 'MCP' },
  { id: 'roles', label: '角色与策略' },
  { id: 'personas', label: '人格预设' },
  { id: 'tools', label: '工具白名单' },
  { grp: '诊断' },
  { id: 'logs', label: '日志' },
  { id: 'search', label: '搜索' },
  { id: 'runtime', label: '运行时' },
  { id: 'settings', label: '面板设置' }
];
const TITLES = {
  overview: ['概览', '整体运行状态'], chat: ['对话', '查看与某人正在进行的会话'],
  tasks: ['任务', '后台子 agent 的进度'], persons: ['人 / 身份', '跨通道识别与归并'],
  memory: ['记忆', '每个人独立保存的事实与偏好'], channels: ['通道', '平台适配器与 QQ 官方机器人'],
  models: ['模型与服务商', '模型角色映射与连通性'], roles: ['角色与策略', '每个角色用哪个模型'],
  tools: ['工具白名单', '前台与子 agent 可用的工具'], logs: ['日志', '与各通道的收发记录'],
  search: ['搜索', '联网检索'], runtime: ['运行时', '热重载与进程重启'],
  scheduled: ['定时任务', '到点主动找他说话'],
  personas: ['人格预设', '一个 agent，多套人格，按对话切换'],
  mcp: ['MCP', '外部工具挂载与「给谁用」勾选'],
  settings: ['面板设置', '访问令牌 / 检索偏好']
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
    JSON.stringify((s.jobs || {})),
    JSON.stringify((s.mcp || {})),
  ].join('|');
}

/* ⚠️ 正在输入时不重画：自动刷新若在用户填表/打字时重画整页，输入会被清掉。
   挂一个「失焦后补画」的监听，离开输入框立刻补上这轮数据。 */
let pendingRender = false;
document.addEventListener('focusout', (e) => {
  if (!pendingRender) return;
  const v = document.getElementById('view');
  if (v && v.contains(e.target)) {
    // 焦点还在 #view 里另一个元素（比如从输入框点到按钮）也不打断
    setTimeout(() => {
      const a = document.activeElement;
      if (pendingRender && a && v.contains(a)) return;
      if (pendingRender) { pendingRender = false; render(); }
    }, 120);
  }
});
function userIsTyping() {
  const a = document.activeElement;
  if (!a) return false;
  const v = document.getElementById('view');
  const inView = v && v.contains(a);
  return inView && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
}

async function refresh(opts) {
  const [state, runtime, qq] = await Promise.all([api('/api/state'), api('/api/runtime'), api('/api/qq')]);
  // 即使是错误响应也要把 ST 建起来，页面才不至于读空 ST
  ST = { state: state || {}, runtime: runtime || {}, qq: qq || {} };
  if (state && state.error) { showGate(); render(); return; }
  $('#gate').style.display = 'none';
  const ge = $('#gate-err'); if (ge) ge.style.display = 'none';
  // ⚠️ 以前这里对每个人**再串行请求一次 /api/chat** 只为数记忆条数 ——
  //    每人一次重请求（要拉完整事件流+记忆+任务），人一多面板就明显卡。
  //    /api/state 已经带了 memoryCount，直接用它。
  const memCount = {};
  for (const p of (ST.state.persons || [])) memCount[p.id] = p.memoryCount || 0;
  ST.memCount = memCount;
  const rt = ST.runtime;
  $('#sf-pid').textContent = rt.pid || '—';
  $('#sf-up').textContent = fmtUptime(rt.uptimeMs || 0);
  const qqS = (ST.qq && ST.qq.status) || {};
  $('#sf-dot').innerHTML = '<i class="dot ' + (qqS.online ? 'ok' : (rt.persons ? 'busy' : 'off')) + '"></i> ' +
    (qqS.online ? '在线' : (rt.watching ? '就绪' : '未监听'));
  lastRefreshAt = Date.now();
  paintRefreshBtn();
  if (signature() !== lastSig || TAB !== lastTab) {
    if (userIsTyping()) { pendingRender = true; } // 输入中：先攒着，失焦再画
    else render();
  }
}

/* ── 顶栏刷新按钮 ─────────────────────── */
let lastRefreshAt = 0;
function paintRefreshBtn() {
  const el = document.getElementById('rf-ago');
  if (el) el.textContent = lastRefreshAt ? ' ' + fmtAgo(lastRefreshAt) : '';
}
setInterval(paintRefreshBtn, 5000);
$('#top-refresh').addEventListener('click', async () => {
  const ico = document.getElementById('rf-ico');
  if (ico) ico.classList.add('spin');
  await refresh();
  toast('✓ 已刷新', 'ok');
  if (ico) setTimeout(() => ico.classList.remove('spin'), 500);
});

/* ── 自动刷新（5s）：后台标签 / 对话页（有自己的 1.2s 节奏）暂停 ── */
setInterval(() => { if (!document.hidden && TAB !== 'chat') refresh(); }, 5000);
setInterval(() => { if (TAB === 'chat') tickChat(); }, 1200);
setInterval(renderLogsIfOpen, 3000);
let lastLogLen = -1;
function renderLogsIfOpen() {
  if (TAB !== 'logs') return;
  if (logPaused || userIsTyping()) return;  // 暂停 / 正在过滤框里打字时不打扰
  const n = ((ST && ST.state && ST.state.log) || []).length;
  if (n === lastLogLen) return;          // 没新增就不重画，免得日志页每 3 秒闪一下
  lastLogLen = n;
  renderLogs($('#view'));
}

/* ── 全局快捷键 ───────────────────────── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDlg(); paletteClose(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    paletteEl.classList.contains('on') ? paletteClose() : paletteOpen();
    return;
  }
  if (typing) return;
  if (e.key === 'r' || e.key === 'R') { $('#top-refresh').click(); }
});

/* ── 启动 ─────────────────────────────── */
$('#hamb').addEventListener('click', () => {
  $('.side').classList.toggle('open');
  $('#sback').classList.toggle('on');
});
$('#sback').addEventListener('click', closeSide);
$('#gate-btn').addEventListener('click', () => {
  localStorage.setItem(KEY, $('#gate-input').value.trim());
  const e = $('#gate-err'); if (e) { e.style.display = 'none'; }
  $('#gate').style.display = 'none';
  refresh();
});
$('#gate-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-btn').click(); });
$('#sf-logout').addEventListener('click', () => {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  location.reload();
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
