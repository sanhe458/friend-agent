/* 页面：runtime */
function renderRuntime(v) {
  const rt = ST.runtime || {};
  const ago = rt.lastReload ? Math.floor((Date.now() - rt.lastReload.at) / 1000) + 's 前' : '—';
  v.innerHTML =
    '<div class="card sec"><h3>进程</h3>' +
      '<table><tbody>' +
      '<tr><th style="width:180px">PID</th><td class="mono num">' + (rt.pid || '—') + '</td></tr>' +
      '<tr><th>Node</th><td class="mono">' + esc(rt.node || '') + '</td></tr>' +
      '<tr><th>工作目录</th><td class="mono">' + esc(rt.cwd || '') + '</td></tr>' +
      '<tr><th>配置文件</th><td class="mono">' + esc(rt.configFile || '') + '</td></tr>' +
      '<tr><th>热重载</th><td>' + (rt.watching ? '<span class="tag on">监听中</span>' : '<span class="tag off">未监听</span>') + ' · 已重载 ' + (rt.reloadCount || 0) + ' 次 · 上次 ' + ago + (rt.lastReload ? '（' + esc(rt.lastReload.reason) + '）' : '') + '</td></tr>' +
      '<tr><th>在跑的轮次</th><td class="num">' + (rt.runningTurns || 0) + '</td></tr>' +
      '</tbody></table></div>' +
    '<div class="card"><h3>操作</h3>' +
      '<p class="hint">改 <b>配置</b>（模型/服务商/QQ/压缩策略）会自动热重载；改 <b>代码</b> 必须重启进程。</p>' +
      '<div class="row"><button class="btn pri" id="rt-reload">重载配置</button>' +
      '<button class="btn danger" id="rt-restart">重启进程</button></div>' +
      '<div id="rt-out" style="margin-top:12px;font-size:12.5px;color:var(--ink2)"></div></div>';
  $('#rt-reload').addEventListener('click', async () => {
    const r = await send('/api/reload');
    $('#rt-out').innerHTML = r.ok ? '✓ ' + esc(r.note) : '✗ ' + esc(r.note);
    await refresh();
  });
  $('#rt-restart').addEventListener('click', () => {
    openDlg('确认重启进程', '<p style="font-size:13px;color:var(--ink2)">约 1 秒内不可用，进行中的对话会中断。新进程会自动接管端口。</p>', '重启', async () => {
      const r = await send('/api/restart');
      toast(r.ok ? '✓ ' + r.note : '✗ ' + r.note);
      setTimeout(() => location.reload(), 2500);
      return true;
    });
  });
}

/* ── 任务 ─────────────────────────────── */

PAGES['runtime'] = { render: renderRuntime };
