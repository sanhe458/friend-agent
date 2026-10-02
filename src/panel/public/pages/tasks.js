/* 页面：tasks */
function renderTasks(v) {
  const tasks = (ST.state.tasks || []).slice().reverse();
  v.innerHTML = '<div class="card pad0">' + (tasks.length ? '<table><thead><tr><th>ID</th><th>类型</th><th>状态</th><th style="width:150px">进度</th><th>结果</th></tr></thead><tbody>' +
    tasks.map((t) => '<tr><td class="mono num">' + esc(t.id) + '</td><td>' + esc(t.kind) + '</td><td>' +
      '<span class="tag ' + (t.status === 'done' ? 'on' : t.status === 'running' ? 'warn' : t.status === 'failed' ? 'off' : '') + '">' + esc(t.status) + '</span></td>' +
      '<td><div class="row"><span class="num" style="font-size:12px;color:var(--ink3)">' + (t.progress || 0) + '%</span>' +
      '<div class="bar" style="flex:1"><i style="width:' + (t.progress || 0) + '%"></i></div></div></td>' +
      '<td style="font-size:12.5px;color:var(--ink2)">' + esc(String(t.result || '—').slice(0, 110)) + '</td></tr>').join('') +
    '</tbody></table>' : '<div class="empty">还没有后台任务</div>') + '</div>';
}

/* ── 人 ───────────────────────────────── */

PAGES['tasks'] = { render: renderTasks };
