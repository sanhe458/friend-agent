/* 页面：channels */
async function renderChannels(v) {
  const rt = ST.runtime || {}, qq = ST.qq || {}, s = qq.status || {};
  const tg = await api('/api/telegram');
  if (v !== document.getElementById('view')) return; // 已切走就不覆盖
  const others = (rt.channels || []).filter((c) => c !== 'qq' && c !== 'telegram');
  v.innerHTML =
    '<div class="card sec"><h3>QQ 官方机器人</h3>' +
      '<div class="grid g3" style="margin-bottom:14px">' +
        '<div class="tile"><div class="k">状态</div><div class="v" style="font-size:20px">' + (s.online ? '在线' : '离线') + '</div>' +
          '<div class="d">' + (s.sessionId ? 'session ' + String(s.sessionId).slice(0, 8) : '无 session') + '</div></div>' +
        '<div class="tile"><div class="k">网关</div><div class="v" style="font-size:20px">' + (s.gatewayConnected ? '已连接' : '未连接') + '</div>' +
          '<div class="d">重连 ' + (s.reconnects || 0) + ' 次</div></div>' +
        '<div class="tile"><div class="k">AppID</div><div class="v mono" style="font-size:17px;padding-top:6px">' + esc(qq.appId || '—') + '</div>' +
          '<div class="d">' + esc(qq.secretMasked || '未配置密钥') + '</div></div>' +
      '</div>' +
      '<div class="row"><button class="btn pri" id="ch-edit">编辑凭据</button>' +
      '<button class="btn" id="ch-check">检查连通性</button>' +
      (qq.adapterMounted ? '' : '<span class="tag warn">通道未挂载</span>') + '</div>' +
      (s.lastError ? '<div class="ev" style="margin-top:12px;color:var(--bad);border-left-color:var(--bad)">' + esc(String(s.lastError).slice(0, 220)) + '</div>' : '') +
      '<p class="hint" style="margin-top:14px">入站走 <b>WebSocket 网关</b>（在线状态只由它给）与 <b>HTTPS 回调</b> <span class="mono">/qq/webhook</span>；出站走 QQBot HTTP。两端同时开启时按事件 id 去重。</p>' +
    '</div>' +
    '<div class="card sec"><h3>Telegram</h3>' +
      '<div class="grid g3" style="margin-bottom:14px">' +
        '<div class="tile"><div class="k">状态</div><div class="v" style="font-size:20px">' + (tg.status && tg.status.ok ? '已连接' : (tg.configured ? '未连接' : '未配置')) + '</div>' +
          '<div class="d">' + esc((tg.status && tg.status.me) || '—') + '</div></div>' +
        '<div class="tile"><div class="k">收到消息</div><div class="v num" style="font-size:20px">' + ((tg.status && tg.status.updates) || 0) + '</div>' +
          '<div class="d">发出 ' + ((tg.status && tg.status.sent) || 0) + ' 条</div></div>' +
        '<div class="tile"><div class="k">Token</div><div class="v mono" style="font-size:15px;padding-top:8px">' + esc(tg.tokenMasked || '未配置') + '</div>' +
          '<div class="d">长轮询 ' + (tg.pollSeconds || 25) + 's</div></div>' +
      '</div>' +
      '<div class="row"><button class="btn pri" id="tg-edit">编辑 Token</button>' +
      (tg.configured ? '<button class="btn danger" id="tg-clear">清除 Token</button>' : '') +
      (tg.adapterMounted ? '<span class="tag on">通道已挂载</span>' : '<span class="tag warn">通道未挂载</span>') + '</div>' +
      (tg.status && tg.status.lastError ? '<div class="ev" style="margin-top:12px;color:var(--bad);border-left-color:var(--bad)">' + esc(String(tg.status.lastError).slice(0, 220)) + '</div>' : '') +
      '<p class="hint" style="margin-top:14px">用<b>长轮询</b>收消息——不需要公网 IP、不需要证书。而且<b>支持真流式</b>（编辑同一条消息，而不是重发）和「正在输入」。</p>' +
    '</div>' +
    '<div class="card"><h3>其他通道</h3>' +
      '<p class="hint">这些是开发期的占位实现（消息只留在内存里），用于在面板/CLI 里跑通链路。</p>' +
      '<div class="grid g3">' + others.map((c) =>
        '<div class="card" style="padding:14px"><div class="row"><b>' + esc(c) + '</b><span class="spacer"></span><span class="tag">占位</span></div>' +
        '<div style="color:var(--ink3);font-size:12.5px;margin-top:6px">入站：模拟 · 出站：内存</div></div>').join('') + '</div></div>';
  $('#ch-edit').addEventListener('click', () => {
    openDlg('QQ 机器人凭据', '' +
      '<label class="f"><span>AppID</span><input id="q-appid" value="' + esc(qq.appId || '') + '"></label>' +
      '<label class="f"><span>ClientSecret（留空 = 不改）</span><input id="q-secret" type="password" placeholder="' + esc(qq.secretMasked || '输入新密钥') + '"></label>' +
      '<div class="grid g2">' +
        '<label class="f"><span>流式最小字符</span><input id="q-min" type="number" value="' + (qq.minChars ?? 24) + '"></label>' +
        '<label class="f"><span>流式静默毫秒</span><input id="q-idle" type="number" value="' + (qq.idleMs ?? 700) + '"></label>' +
      '</div>' +
      '<div class="row" style="margin-bottom:6px"><div class="sw"><input type="checkbox" id="q-stream"' + (qq.useStreaming ? ' checked' : '') + '><i></i></div>' +
        '<span style="font-size:13px">启用 C2C 流式（不推荐，稳定优先）</span></div>' +
      '<div class="row"><div class="sw"><input type="checkbox" id="q-gw"' + (qq.gateway === false ? '' : ' checked') + '><i></i></div>' +
        '<span style="font-size:13px">连 WebSocket 网关（决定“在线状态”）</span></div>', '保存', async () => {
      const body = {
        appId: $('#q-appid').value.trim(),
        minChars: Number($('#q-min').value), idleMs: Number($('#q-idle').value),
        useStreaming: $('#q-stream').checked, gateway: $('#q-gw').checked
      };
      body['client' + 'Secret'] = $('#q-secret').value;
      const r = await send('/api/qq', body);
      toast(r.ok ? '✓ 已保存并即时生效' : '✗ ' + (r.error || '失败'));
      await refresh(); return true;
    });
  });
  $('#ch-check').addEventListener('click', async () => { toast('检查中…'); const r = await send('/api/qq/check'); toast((r.ok ? '✓ ' : '✗ ') + r.note); });

  const tge = $('#tg-edit');
  if (tge) tge.addEventListener('click', () => {
    openDlg('Telegram Bot Token',
      '<label class="f"><span>Bot Token（留空 = 不改）</span><input id="tg-token" type="password" placeholder="' + esc(tg.tokenMasked || '123456:AA...') + '"></label>' +
      '<p class="hint" style="margin:-6px 0 12px">在 Telegram 里找 @BotFather → /newbot 拿 token。</p>' +
      '<div class="grid g2">' +
        '<label class="f"><span>长轮询秒数</span><input id="tg-poll" type="number" value="' + (tg.pollSeconds || 25) + '"></label>' +
        '<label class="f"><span>只收这些 chat id（逗号分隔，留空=都收）</span><input id="tg-allow" value="' + esc((tg.allowFrom || []).join(',')) + '"></label>' +
      '</div>' +
      '<div class="row" style="margin:2px 0 4px"><div class="sw"><input type="checkbox" id="tg-stream"' + (tg.streaming ? ' checked' : '') + '><i></i></div>' +
        '<span style="font-size:13px">流式输出（编辑同一条消息）</span></div>' +
      '<p class="hint" style="margin:0 0 8px">默认关。实测问题较多（丢帧、编辑限流），而且「正在输入」与它无关，关掉不影响。</p>', '保存', async () => {
      const r = await send('/api/telegram', {
        token: $('#tg-token').value,
        pollSeconds: Number($('#tg-poll').value),
        allowFrom: $('#tg-allow').value.split(',').map((s) => s.trim()).filter(Boolean).map(Number),
        streaming: $('#tg-stream').checked,
      });
      toast(r.ok ? '✓ 已保存并即时生效' : '✗ ' + (r.error || '失败'));
      await refresh();
      renderChannels(v);
      return true;
    });
  });

  const tgc = $('#tg-clear');
  if (tgc) tgc.addEventListener('click', () => {
    openDlg('清除 Telegram Token', '<p style="font-size:13px;color:var(--ink2)">清除后 Telegram 通道会立即卸载，不再收发消息。</p>', '清除', async () => {
      const r = await send('/api/telegram', { clearToken: true });
      toast(r.ok ? '✓ 已清除' : '✗ ' + (r.error || '失败'));
      await refresh();
      renderChannels(v);
      return true;
    });
  });
}

/* ── 模型 ─────────────────────────────── */

PAGES['channels'] = { render: renderChannels };
