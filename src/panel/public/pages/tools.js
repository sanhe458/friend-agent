/* 页面：tools */
function renderTools(v) {
  const tools = ST.state.tools || [];
  const specs = ST.state.specialists || [];
  v.innerHTML =
    '<div class="card pad0 sec"><div class="row" style="padding:16px 18px 12px"><h3 style="margin:0">前台可用工具</h3>' +
      '<span class="spacer"></span><span class="tag">' + tools.length + ' 个</span></div>' +
      (tools.length ? '<table><thead><tr><th>工具</th><th>说明</th></tr></thead><tbody>' +
        tools.map((t) => '<tr><td class="mono">' + esc(t.name || t) + '</td><td style="color:var(--ink2)">' + esc(t.description || '—') + '</td></tr>').join('') +
        '</tbody></table>' : '<div class="empty">未读取到工具清单</div>') + '</div>' +
    '<div class="card pad0"><div class="row" style="padding:16px 18px 12px"><h3 style="margin:0">子 agent 专员</h3></div>' +
      (specs.length ? '<table><thead><tr><th>类型</th><th>名称</th><th>说明</th></tr></thead><tbody>' +
        specs.map((s) => '<tr><td class="mono">' + esc(s.kind) + '</td><td><b>' + esc(s.label) + '</b></td><td style="color:var(--ink2)">' + esc(s.description) + '</td></tr>').join('') +
        '</tbody></table>' : '<div class="empty">未读取到专员清单</div>') + '</div>';
}

/* ── 日志 ─────────────────────────────── */

PAGES['tools'] = { render: renderTools };
