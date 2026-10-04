/* 页面：tasks
 * 2026-10-04 升级：状态过滤、自动刷新（页签开着时）、归属人 / 创建时间列、结果完整查看弹窗。
 */
let taskFilter = 'all';
function renderTasks(v) {
  const all = (ST.state.tasks || []).slice().reverse();
  const rows = all.filter((t) => taskFilter === 'all' || t.status === taskFilter);
  const cnt = (s) => all.filter((t) => t.status === s).length;
  v.innerHTML =
    '<div class="row sec"><div class="pills" id="tk-pills">' +
      ['all', 'running', 'done', 'failed'].map((k) =>
        '<button data-k="' + k + '"' + (k === taskFilter ? ' class="on"' : '') + '>' +
        ({ all: '全部 ' + all.length, running: '运行 ' + cnt('running'), done: '完成 ' + cnt('done'), failed: '失败 ' + cnt('failed') }[k]) + '</button>').join('') +
      '</div><span class="spacer"></span>' +
      '<span style="color:var(--ink3);font-size:12.5px">每 5s 自动刷新</span></div>' +
    '<div class="card pad0">' + (rows.length
      ? '<table><thead><tr><th>任务</th><th>归属人</th><th>状态</th><th style="width:150px">进度</th><th>开始时间</th><th>结果</th></tr></thead><tbody>' +
      rows.map((t) => {
        const res = String(t.result || '');
        return '<tr><td><b>' + esc(t.kind) + '</b><div class="mono" style="font-size:11px;color:var(--ink3)">' + esc(t.id) + '</div>' +
          '<div style="font-size:12px;color:var(--ink2);margin-top:3px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(t.prompt || '') + '">' + esc(String(t.prompt || '').slice(0, 60) || '—') + '</div></td>' +
          '<td class="mono" style="font-size:12px">' + esc(t.personId || '—') + '</td>' +
          '<td><span class="tag ' + (t.status === 'done' ? 'on' : t.status === 'running' ? 'warn' : 'off') + '">' +
          (t.status === 'running' ? '运行中' : t.status === 'done' ? '完成' : '失败') + '</span></td>' +
          '<td><div class="row"><span class="num" style="font-size:12px;color:var(--ink3)">' + (t.progress || 0) + '%</span>' +
          '<div class="bar" style="flex:1"><i style="width:' + (t.progress || 0) + '%"></i></div></div></td>' +
          '<td class="mono num" style="font-size:12px;color:var(--ink3)">' + (t.createdAt ? fmtAgo(t.createdAt) : '—') + '</td>' +
          '<td style="font-size:12.5px;color:var(--ink2)">' +
          (res
            ? '<span class="t-res" data-res="' + esc(t.id) + '" style="cursor:pointer;border-bottom:1px dashed var(--line)">' + esc(res.slice(0, 60)) + (res.length > 60 ? ' …' : '') + '</span>'
            : '<span style="color:var(--ink3)">—</span>') + '</td></tr>';
      }).join('') +
      '</tbody></table>'
      : '<div class="empty">' + (all.length ? '这个过滤条件下没有任务' : '还没有后台任务。让 agent 帮你做点事（比如「帮我查查…」），子 agent 任务会出现在这里。') + '</div>') +
    '</div>' +
    '<div id="tk-res-holder"></div>';
  $$('#tk-pills button').forEach((b) => b.addEventListener('click', () => { taskFilter = b.getAttribute('data-k'); renderTasks(v); }));
  // 结果全文弹窗（表格里截断 60 字，点开看全文）
  const tasks = ST.state.tasks || [];
  $$('[data-res]').forEach((el) => el.addEventListener('click', () => {
    const t = tasks.find((x) => x.id === el.getAttribute('data-res'));
    if (!t) return;
    openDlg('任务结果 · ' + t.kind,
      '<p class="hint" style="margin:0 0 8px"><b class="mono">' + esc(t.id) + '</b> · 归属 ' + esc(t.personId || '—') + ' · ' +
      (t.createdAt ? '创建于 ' + fmtDateTime(t.createdAt) : '') + '</p>' +
      '<div class="ev" style="white-space:pre-wrap;max-height:50vh;overflow:auto">' + esc(String(t.result || '')) + '</div>', null, null);
  }));
}

PAGES['tasks'] = { render: renderTasks };
