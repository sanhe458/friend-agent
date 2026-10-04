/* 页面：logs
 * 2026-10-04 升级：文本过滤、暂停/恢复自动刷新、显示条数上限、错误行筛选。
 */
let logFilter = 'all';
let logQuery = '';
let logPaused = false;
let logLimit = 200;
function renderLogs(v) {
  const all = (ST.state.log || []).slice().reverse();
  const q = logQuery.trim().toLowerCase();
  const isErr = (e) => /失败|错误|❌|\[JS\]|Exception/i.test(String(e.text));
  const rows = all
    .filter((e) => logFilter === 'all' || (logFilter === 'in' && e.dir === 'in') || (logFilter === 'out' && e.dir === 'out') || (logFilter === 'sys' && e.dir === 'sys') || (logFilter === 'err' && isErr(e)))
    .filter((e) => !q || String(e.text).toLowerCase().includes(q))
    .slice(0, logLimit);
  v.innerHTML =
    '<div class="row sec">' +
      '<div class="pills" id="lg-pills">' +
        ['all', 'in', 'out', 'sys', 'err'].map((k) => '<button data-k="' + k + '"' + (k === logFilter ? ' class="on"' : '') + '>' +
          ({ all: '全部', in: '入站', out: '出站', sys: '系统', err: '错误' }[k]) + '</button>').join('') + '</div>' +
      '<input id="lg-q" value="' + esc(logQuery) + '" placeholder="在日志里搜…" style="width:220px">' +
      '<select id="lg-limit" style="width:110px">' +
        [200, 500, 1000].map((n) => '<option value="' + n + '"' + (n === logLimit ? ' selected' : '') + '>最近 ' + n + ' 条</option>').join('') + '</select>' +
      '<button class="btn sm' + (logPaused ? ' danger' : '') + '" id="lg-pause">' + (logPaused ? '已暂停（点此恢复）' : '暂停自动刷新') + '</button>' +
      '<span class="tag">' + rows.length + ' 条</span><span class="spacer"></span>' +
      '<span style="color:var(--ink3);font-size:12.5px">' + (logPaused ? '手动模式' : '自动刷新 3s') + '</span></div>' +
    '<div class="card pad0"><div class="logs">' + (rows.length ? rows.map((e) => {
      const cls = e.dir === 'in' ? 'in' : e.dir === 'out' ? 'out' : isErr(e) ? 'err' : 'sys';
      return '<div class="l ' + cls + '"><span class="t">' + fmtTime(e.at) + '</span>' +
        '<span class="c">' + esc(e.channel || '-') + '</span><span class="x">' + esc(String(e.text || '').slice(0, 400)) + '</span></div>';
    }).join('') : '<div class="empty">' + (q ? '没有匹配「' + esc(logQuery) + '」的日志' : '暂无日志') + '</div>') + '</div></div>';
  $$('#lg-pills button').forEach((b) => b.addEventListener('click', () => { logFilter = b.getAttribute('data-k'); renderLogs(v); }));
  $('#lg-q').addEventListener('input', (e) => { logQuery = e.target.value; renderLogsKeepFocus(v); });
  $('#lg-limit').addEventListener('change', (e) => { logLimit = Number(e.target.value); renderLogs(v); });
  $('#lg-pause').addEventListener('click', () => { logPaused = !logPaused; lastLogLen = -1; renderLogs(v); });
}
/* 过滤输入时保留焦点与光标：renderLogs 会整页重建，输入框一重建焦点就丢 */
function renderLogsKeepFocus(v) {
  const el = document.getElementById('lg-q');
  const pos = el ? el.selectionStart : 0;
  renderLogs(v);
  const el2 = document.getElementById('lg-q');
  if (el2) { el2.focus(); try { el2.setSelectionRange(pos, pos); } catch { /* ignore */ } }
}

PAGES['logs'] = { render: renderLogs };
