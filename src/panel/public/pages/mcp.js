/* 页面：mcp —— MCP 服务器管理与「给谁用」勾选
 *
 * 三河 2026-10-02：外部 MCP 工具挂进来后，要能勾选给谁用：
 *   □ 回复模型（reply）  □ 子 agent（sub）—— 都不勾 = 都能用
 */
async function renderMcp(v) {
  const d = await api('/api/mcp');
  const servers = d.servers || [];
  const status = {};
  (d.status || []).forEach((s) => { status[s.id] = s; });

  const audTxt = (a) => (!a || !a.length ? '两边都用' : a.map((x) => (x === 'reply' ? '回复模型' : '子 agent')).join(' + '));

  v.innerHTML =
    '<div class="card"><div class="row"><h3 style="margin:0">MCP 服务器</h3>' +
      '<span class="spacer"></span><button class="btn pri sm" id="mcp-add">+ 添加服务器</button></div>' +
      '<p class="hint">把外部 MCP 服务器的工具挂进来（stdio 传输：本地起一个子进程）。' +
      '工具名会加 <b class="mono">mcp_服务器id_</b> 前缀，避免和内置工具撞名。<br>' +
      '<b>「给谁用」</b>：都不勾 = 回复模型和子 agent 都能用；只勾一个 = 只有那一方看得到。</p>' +
      (servers.length
        ? '<table class="acts"><thead><tr><th>ID</th><th>命令</th><th>状态</th><th>给谁用</th><th></th></tr></thead><tbody>' +
          servers.map((s) => {
            const st = status[s.id] || {};
            const ok = st.connected === true;
            return '<tr><td><b>' + esc(s.id) + '</b></td>' +
              '<td class="mono" style="font-size:12px">' + esc([s.command].concat(s.args || []).join(' ').slice(0, 52)) + '</td>' +
              '<td>' + (s.enabled === false
                ? '<span class="tag off">停用</span>'
                : (ok ? '<span class="tag on">已连</span><div class="hint" style="margin:0">' + (st.tools || 0) + ' 个工具</div>'
                     : '<span class="tag warn">断开</span><div class="hint" style="margin:0">' + esc(String(st.lastError || '').slice(0, 40)) + '</div>')) + '</td>' +
              '<td>' + esc(audTxt(s.audience)) + '</td>' +
              '<td class="row"><button class="btn sm" data-act="edit" data-id="' + esc(s.id) + '">编辑</button>' +
              '<button class="btn sm" data-act="reconnect" data-id="' + esc(s.id) + '">重连</button>' +
              '<button class="btn sm danger" data-act="del" data-id="' + esc(s.id) + '">删除</button></td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="empty">还没配 MCP 服务器。点右上角「+ 添加服务器」。</div>') +
      '</div>';

  const saveAll = async (list) => {
    const r = await send('/api/mcp', { servers: list });
    toast(r.ok ? '✓ 已保存并同步连接' : '✗ ' + (r.error || '失败'));
    await refresh(); render();
  };

  const dlg = (existing) => {
    const s = existing || {};
    const aud = s.audience || [];
    openDlg(existing ? '编辑 MCP 服务器' : '添加 MCP 服务器',
      '<label class="f"><span>ID（唯一键' + (existing ? '，不可改' : '') + '）</span><input id="ms-id" value="' + esc(s.id || '') + '"' + (existing ? ' readonly' : '') + ' placeholder="filesystem"></label>' +
      '<label class="f"><span>启动命令（stdio）或 MCP 端点 URL（http/https）</span><input id="ms-cmd" value="' + esc(s.command || '') + '" placeholder="npx … 或 https://mcp.example.com/mcp"></label>' +
      '<label class="f"><span>HTTP 请求头（可选，JSON，如 {"Authorization":"Bearer xx"}）</span><input id="ms-headers" value="' + esc(s.headers ? JSON.stringify(s.headers) : '') + '" placeholder=\'{"Authorization":"Bearer …"}\'></label>' +
      '<label class="f"><span>参数（空格分隔）</span><input id="ms-args" value="' + esc((s.args || []).join(' ')) + '" placeholder="-y @modelcontextprotocol/server-filesystem /tmp"></label>' +
      '<label class="f"><span>工作目录（可选）</span><input id="ms-cwd" value="' + esc(s.cwd || '') + '"></label>' +
      '<label class="f"><span>给谁用</span><span class="row" style="gap:18px">' +
        '<label class="row" style="gap:6px;margin:0"><input type="checkbox" id="ms-aud-reply" style="width:auto"' + (aud.includes('reply') ? ' checked' : '') + '> 回复模型</label>' +
        '<label class="row" style="gap:6px;margin:0"><input type="checkbox" id="ms-aud-sub" style="width:auto"' + (aud.includes('sub') ? ' checked' : '') + '> 子 agent</label>' +
      '</span><span class="hint" style="display:block;margin-top:4px">都不勾 = 两边都能用</span></label>' +
      '<label class="f"><span>启用</span><label class="row" style="gap:6px;margin:0"><input type="checkbox" id="ms-en" style="width:auto"' + (s.enabled !== false ? ' checked' : '') + '> 启用这台服务器</label></label>' +
      '<p class="hint" style="margin:-6px 0 8px">保存后会立即连接并挂载工具；连接失败会在列表里标出来。</p>',
      '保存', async () => {
        const id = $('#ms-id').value.trim();
        const command = $('#ms-cmd').value.trim();
        if (!id || !command) { toast('✗ ID 和启动命令必填'); return false; }
        const others = servers.filter((x) => x.id !== id);
        const entry = {
          id,
          command,
          args: $('#ms-args').value.trim() ? $('#ms-args').value.trim().split(/\s+/) : [],
          audience: [$('#ms-aud-reply').checked ? 'reply' : '', $('#ms-aud-sub').checked ? 'sub' : ''].filter(Boolean),
          enabled: $('#ms-en').checked,
        };
        try {
          const h = $('#ms-headers').value.trim();
          if (h) entry.headers = JSON.parse(h); // 写错 JSON 直接拦下，别存坏配置
        } catch { toast('✗ 请求头不是合法 JSON'); return false; }
        const cwd = $('#ms-cwd').value.trim();
        if (cwd) entry.cwd = cwd;
        await saveAll(others.concat([entry]));
        return true;
      });
  };

  $$('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.getAttribute('data-act');
    const id = b.getAttribute('data-id');
    if (act === 'edit') return dlg(servers.find((x) => x.id === id));
    if (act === 'del') {
      openDlg('删除 MCP 服务器',
        '<p style="font-size:13px;color:var(--ink2)">确定删除 <b class="mono">' + esc(id) + '</b>？它的全部工具会从注册表摘掉。</p>',
        '删除', async () => { await saveAll(servers.filter((x) => x.id !== id)); return true; });
      return;
    }
    if (act === 'reconnect') {
      toast('重连中…');
      const r = await send('/api/mcp/reconnect', { id });
      toast(r.ok ? r.note : '✗ ' + (r.note || '失败'));
      await refresh(); render();
    }
  }));
  const add = $('#mcp-add');
  if (add) add.addEventListener('click', () => dlg(null));
}

PAGES['mcp'] = { render: renderMcp };
