/* 页面：logs */
let logFilter = 'all';
function renderLogs(v) {
  const all = (ST.state.log || []).slice().reverse();
  const rows = all.filter((e) => logFilter === 'all' || (logFilter === 'in' && e.dir === 'in') || (logFilter === 'out' && e.dir === 'out') || (logFilter === 'sys' && e.dir === 'sys'));
  v.innerHTML =
    '<div class="row sec"><div class="pills" id="lg-pills">' +
      ['all', 'in', 'out', 'sys'].map((k) => '<button data-k="' + k + '"' + (k === logFilter ? ' class="on"' : '') + '>' +
        ({ all: '全部', in: '入站', out: '出站', sys: '系统' }[k]) + '</button>').join('') + '</div>' +
      '<span class="tag">' + rows.length + ' 条</span><span class="spacer"></span>' +
      '<span style="color:var(--ink3);font-size:12.5px">自动刷新 3s</span></div>' +
    '<div class="card pad0"><div class="logs">' + (rows.length ? rows.map((e) => {
      const cls = e.dir === 'in' ? 'in' : e.dir === 'out' ? 'out' : /失败|错误|❌/.test(String(e.text)) ? 'err' : 'sys';
      return '<div class="l ' + cls + '"><span class="t">' + new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }) + '</span>' +
        '<span class="c">' + esc(e.channel || '-') + '</span><span class="x">' + esc(String(e.text || '').slice(0, 400)) + '</span></div>';
    }).join('') : '<div class="empty">暂无日志</div>') + '</div></div>';
  $$('#lg-pills button').forEach((b) => b.addEventListener('click', () => { logFilter = b.getAttribute('data-k'); renderLogs(v); }));
}

/* ── 搜索 ─────────────────────────────── */

PAGES['logs'] = { render: renderLogs };
