/* 页面：overview
 * 2026-10-04 升级：8 个指标 tiles（补记忆/定时/MCP）、快捷操作、人员速览卡。
 *   以前的「运行时长 1847m」换算成天/小时；最近动态可以一键跳日志页。
 */
function renderOverview(v) {
  const rt = ST.runtime || {}, st = ST.state || {};
  const persons = st.persons || [];
  const tasks = st.tasks || [];
  const running = tasks.filter((x) => x.status === 'running').length;
  const qq = (ST.qq && ST.qq.status) || {};
  const jobs = st.jobs || { total: 0, enabled: 0 };
  const mcp = st.mcp || { servers: 0, connected: 0, tools: 0 };
  const memories = st.counts ? st.counts.memories : 0;
  const tiles = [
    ['运行时长', fmtUptime(rt.uptimeMs || 0), 'pid ' + (rt.pid || '—')],
    ['人数', String(persons.length), persons.length ? '共 ' + memories + ' 条记忆' : '还没有人'],
    ['记忆', String(memories), persons.length ? '按人分片 · 语义召回' : '按人分片存储'],
    ['任务', String(tasks.length), running ? running + ' 个在跑' : '全部结束'],
    ['定时任务', jobs.total ? jobs.enabled + ' / ' + jobs.total : '0', jobs.enabled ? '启用中' : '没有启用中的'],
    ['MCP', mcp.servers ? mcp.connected + ' / ' + mcp.servers : '0', mcp.tools ? '挂载 ' + mcp.tools + ' 个工具' : '未配置服务器'],
    ['工具', String(rt.tools || 0), '可被调用'],
    ['热重载', String(rt.reloadCount || 0) + ' 次', rt.watching ? '监听配置中' : '未监听'],
  ];
  v.innerHTML =
    '<div class="grid g4 sec">' + tiles.map((x) =>
      '<div class="tile"><div class="k">' + esc(x[0]) + '</div><div class="v num">' + esc(x[1]) + '</div><div class="d">' + esc(x[2]) + '</div></div>'
    ).join('') + '</div>' +
    '<div class="grid g2 sec">' +
      '<div class="card"><h3>QQ 官方机器人</h3>' +
        '<div class="row" style="margin-bottom:10px">' +
          '<span class="tag ' + (qq.online ? 'on' : 'off') + '">' + (qq.online ? '在线' : '离线') + '</span>' +
          '<span class="tag">网关 ' + (qq.gatewayConnected ? '已连接' : '未连接') + '</span>' +
          '<span class="tag">重连 ' + (qq.reconnects || 0) + ' 次</span>' +
        '</div>' +
        '<div style="font-size:12.5px;color:var(--ink3)">' +
          (ST.qq && ST.qq.configured ? 'AppID ' + esc(ST.qq.appId) + ' · 密钥 ' + esc(ST.qq.secretMasked || '') : '未配置') + '</div>' +
        (qq.lastError ? '<div class="ev" style="color:var(--bad);border-left-color:var(--bad);margin-top:10px">' + esc(String(qq.lastError).slice(0, 200)) + '</div>' : '') +
        '<div class="row" style="margin-top:12px"><button class="btn sm" id="ov-qq">去配置</button>' +
        '<button class="btn sm" id="ov-check">检查连通性</button></div>' +
      '</div>' +
      '<div class="card"><h3>最近动态</h3>' +
        '<div id="ov-feed">' +
        ((st.log || []).slice(-8).reverse().map((e) =>
          '<div class="ev"><span class="n">' + (e.dir === 'in' ? '←' : e.dir === 'out' ? '→' : '·') + '</span> ' +
          '<span style="color:var(--ink3);font-size:10.5px">' + fmtTime(e.at) + '</span> ' +
          esc(String(e.text || '').slice(0, 80)) + '</div>').join('') || '<div class="empty">暂无</div>') +
        '</div>' +
        '<div class="row" style="margin-top:10px"><button class="btn sm" id="ov-logs">全部日志 →</button></div>' +
      '</div>' +
    '</div>' +
    '<div class="card sec"><div class="row"><h3 style="margin:0">快捷操作</h3><span class="spacer"></span>' +
      '<button class="btn sm pri" data-quick="chat">去对话</button>' +
      '<button class="btn sm" data-quick="memory">新增记忆</button>' +
      '<button class="btn sm" data-quick="scheduled">新建定时</button>' +
      '<button class="btn sm" data-quick="palette">快速跳转 · Ctrl K</button>' +
    '</div></div>' +
    '<div class="card pad0"><div class="row" style="padding:16px 18px 12px"><h3 style="margin:0">人员速览</h3>' +
      '<span class="spacer"></span><button class="btn sm" data-quick="persons">管理 →</button></div>' +
      (persons.length
        ? '<div class="grid g3" style="padding:0 18px 18px">' + persons.slice(0, 9).map((p) => {
            const b0 = (p.bindings || [])[0] || {};
            return '<div class="card" style="padding:13px 15px;cursor:pointer" data-person-go="' + esc(b0.channel + '|' + b0.externalId) + '" title="点开和 ' + esc(p.displayName || p.id) + ' 的对话">' +
              '<div class="row"><b>' + esc(p.displayName || p.id) + '</b><span class="spacer"></span><span class="tag">' + ((ST.memCount || {})[p.id] || 0) + ' 条记忆</span></div>' +
              '<div style="color:var(--ink3);font-size:12px;margin-top:5px">' +
                esc((p.bindings || []).map((b) => b.channel + ':' + String(b.externalId).slice(0, 14)).join(' · ') || '无绑定') +
              '</div></div>';
          }).join('') + (persons.length > 9 ? '<div class="empty" style="grid-column:1/-1;padding:10px">还有 ' + (persons.length - 9) + ' 个人 → 去「人 / 身份」查看</div>' : '') + '</div>'
        : '<div class="empty">还没有识别到任何人。在对话里说一句话（面板对话页 / QQ / Telegram），就会自动建档。</div>') +
    '</div>';
  $('#ov-qq').addEventListener('click', () => go('channels'));
  $('#ov-check').addEventListener('click', async () => { toast('检查中…'); const r = await send('/api/qq/check'); toast(r.ok ? '✓ ' + r.note : '✗ ' + r.note, r.ok ? 'ok' : 'err'); });
  $('#ov-logs').addEventListener('click', () => go('logs'));
  $$('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const t = b.getAttribute('data-quick');
    if (t === 'palette') return paletteOpen();
    go(t);
  }));
  $$('[data-person-go]').forEach((el) => el.addEventListener('click', () => {
    const val = el.getAttribute('data-person-go');
    try { sessionStorage.setItem('fa_chat_pick', JSON.stringify({ channel: val.split('|')[0], externalId: val.split('|')[1] })); } catch { /* ignore */ }
    go('chat');
  }));
}

PAGES['overview'] = { render: renderOverview };
