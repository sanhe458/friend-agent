/* 页面：overview */
function renderOverview(v) {
  const rt = ST.runtime || {}, st = ST.state || {};
  const persons = (st.persons || []).length;
  const chans = (rt.channels || []).length;
  const tasks = (st.tasks || []).length;
  const running = (st.tasks || []).filter((x) => x.status === 'running').length;
  const qq = (ST.qq && ST.qq.status) || {};
  const up = Math.floor((rt.uptimeMs || 0) / 1000);
  const tiles = [
    ['运行时长', Math.floor(up / 60) + 'm' + (up % 60) + 's', 'pid ' + (rt.pid || '—')],
    ['人数', String(persons), '独立人格记忆'],
    ['通道', String(chans), (rt.channels || []).join(' · ') || '—'],
    ['任务', String(tasks), running ? running + ' 个在跑' : '全部结束'],
    ['工具', String(rt.tools || 0), '可被调用'],
    ['热重载', String(rt.reloadCount || 0) + ' 次', rt.watching ? '监听中' : '未监听']
  ];
  v.innerHTML =
    '<div class="grid g3 sec">' + tiles.map((x) =>
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
        ((st.log || []).slice(-7).reverse().map((e) =>
          '<div class="ev"><span class="n">' + (e.dir === 'in' ? '←' : e.dir === 'out' ? '→' : '·') + '</span> ' +
          esc(String(e.text || '').slice(0, 90)) + '</div>').join('') || '<div class="empty">暂无</div>') +
      '</div>' +
    '</div>' +
    '<div class="card pad0"><h3 style="padding:16px 18px 0">通道清单</h3>' +
      '<table class="plain"><thead><tr><th>通道</th><th>类型</th><th>入站</th><th>出站</th><th>“正在输入”</th></tr></thead><tbody>' +
      (rt.channelInfo || (rt.channels || []).map((id) => ({ id, kind: 'mock', typing: false }))).map((c) => {
        // ⚠️ 以前是硬编码 `c === 'qq' && rt.qqMounted` —— Telegram 明明配好且在跑，也永远显示「占位」。
        //    现在每个适配器自报 kind，面板照实渲染。
        const isReal = c.kind === 'real';
        const off = c.id === 'qq' && !qq.online; // 只有 QQ 有显式的在线状态
        const typing = !c.typing
          ? '—'
          : (off ? '<span class="tag">离线</span>' : '<span class="tag on">可用</span>');
        return '<tr><td><b>' + esc(c.id) + '</b></td>' +
          '<td>' + (isReal ? '真实' : '<span style="color:var(--ink3)">占位</span>') + '</td>' +
          '<td>' + (isReal ? '真实推送' : '模拟') + '</td>' +
          '<td>' + (isReal ? '真实 API' : '内存') + '</td>' +
          '<td>' + typing + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  const b1 = $('#ov-qq'); if (b1) b1.addEventListener('click', () => go('channels'));
  const b2 = $('#ov-check'); if (b2) b2.addEventListener('click', async () => { toast('检查中…'); const r = await send('/api/qq/check'); toast(r.ok ? '✓ ' + r.note : '✗ ' + r.note); });
}

/* ── 运行时 ───────────────────────────── */

PAGES['overview'] = { render: renderOverview };
