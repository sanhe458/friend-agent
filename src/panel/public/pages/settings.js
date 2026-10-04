/* 页面：settings —— 面板自身的设置
 * 2026-10-04 新增：以前改访问令牌/秘塔 key 只能登服务器改配置文件。
 *   注意：改令牌后前端要立刻把新令牌写进 localStorage，否则下一个请求就被自己锁在门外。
 */
async function renderSettings(v) {
  const d = await api('/api/settings');
  if (TAB !== 'settings' || v !== document.getElementById('view')) return; // await 期间切走了
  if (d.error) { v.innerHTML = '<div class="empty">读取失败</div>'; return; }
  v.innerHTML =
    '<div class="card sec"><h3>面板访问令牌</h3>' +
      '<div class="row" style="margin-bottom:10px">' +
        (d.panelTokenSet
          ? '<span class="tag on">已启用</span><span class="mono" style="color:var(--ink3)">' + esc(d.panelTokenMasked) + '</span>'
          : '<span class="tag warn">未设置</span><span style="font-size:12.5px;color:var(--ink3)">仅本机（127.0.0.1）可以访问面板 API</span>') +
        (d.panelTokenFromEnv ? '<span class="tag info">PANEL_TOKEN 环境变量优先，这里改了也会被它盖掉</span>' : '') +
      '</div>' +
      '<label class="f" style="max-width:420px"><span>设置新令牌（留空 = 不改）</span>' +
        '<input id="st-token" type="password" placeholder="输入新令牌，比如一串长随机字符"></label>' +
      '<div class="row">' +
        '<button class="btn pri" id="st-token-save">保存令牌</button>' +
        (d.panelTokenSet ? '<button class="btn danger" id="st-token-clear">清除令牌（回到仅本机可访问）</button>' : '') +
      '</div>' +
      '<p class="hint" style="margin-top:12px">令牌保存在 <span class="mono">config.local.json</span>（0600，已 gitignore），保存后<b>即时生效</b>，不用重启。所有带令牌的浏览器标签页都会被要求重新输入。</p>' +
    '</div>' +
    '<div class="card sec"><h3>秘塔（metaso）检索</h3>' +
      '<p class="hint">联网搜索的供应商。agent 的「查最新资料」和面板「搜索」页都走它。<a href="https://metaso.cn" target="_blank" rel="noopener">metaso.cn ↗</a></p>' +
      '<div class="row" style="margin-bottom:10px">' +
        (d.metasoSet
          ? '<span class="tag on">已配置</span><span class="mono" style="color:var(--ink3)">' + esc(d.metasoMasked) + '</span>'
          : '<span class="tag warn">未配置</span>') +
        (d.metasoFromEnv ? '<span class="tag info">METASO_API_KEY 环境变量优先</span>' : '') +
      '</div>' +
      '<label class="f" style="max-width:420px"><span>API Key（留空 = 不改）</span>' +
        '<input id="st-metaso" type="password" placeholder="mt-… 或 sk-…"></label>' +
      '<div class="row">' +
        '<button class="btn pri" id="st-metaso-save">保存 Key</button>' +
        (d.metasoSet ? '<button class="btn danger" id="st-metaso-clear">清除 Key</button>' : '') +
      '</div>' +
    '</div>' +
    '<div class="card"><h3>检索偏好</h3>' +
      '<div class="grid g2" style="max-width:560px">' +
        '<label class="f"><span>默认范围</span><select id="st-scope">' +
          ['webpage:网页', 'news:新闻', 'paper:学术'].map((x) => {
            const [val, t] = x.split(':');
            return '<option value="' + val + '"' + ((d.metasoScope || 'webpage') === val ? ' selected' : '') + '>' + t + '</option>';
          }).join('') +
        '</select></label>' +
        '<label class="f"><span>每次检索条数（1–20）</span><input id="st-size" type="number" min="1" max="20" value="' + (d.searchSize || 5) + '"></label>' +
      '</div>' +
      '<div class="row end"><button class="btn pri" id="st-pref-save">保存偏好</button></div>' +
    '</div>';

  $('#st-token-save').addEventListener('click', async () => {
    const t = $('#st-token').value.trim();
    if (!t) { toast('先输入新令牌', 'err'); return; }
    openDlg('确认更换访问令牌',
      '<p style="font-size:13px;color:var(--ink2)">新令牌保存后会<b>立即生效</b>，本页面会自动换用新令牌；其它已打开的面板标签页需要重新输入。</p>' +
      '<p style="font-size:13px"><b class="mono">' + esc(t) + '</b></p>' +
      '<p class="hint">请先把它抄下来 —— 忘了就只能登服务器看启动日志或改配置文件。</p>', '确认更换', async () => {
      const r = await send('/api/settings', { panelToken: t });
      if (!r.ok) { toast('✗ ' + (r.error || '失败'), 'err'); return false; }
      try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
      toast('✓ 令牌已更换并即时生效', 'ok');
      await refresh(); renderSettings(v);
      return true;
    });
  });

  const clearTok = $('#st-token-clear');
  if (clearTok) clearTok.addEventListener('click', () => {
    openDlg('清除访问令牌',
      '<p style="font-size:13px;color:var(--ink2)">清除后<b>只允许本机（127.0.0.1）访问面板</b>；从其它机器打开会被拒。确定？</p>', '清除', async () => {
      const r = await send('/api/settings', { clearPanelToken: true });
      if (!r.ok) { toast('✗ ' + (r.error || '失败'), 'err'); return false; }
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      toast('✓ 令牌已清除', 'ok');
      await refresh(); renderSettings(v);
      return true;
    });
  });

  $('#st-metaso-save').addEventListener('click', async () => {
    const t = $('#st-metaso').value.trim();
    if (!t) { toast('先输入 API Key', 'err'); return; }
    const r = await send('/api/settings', { metasoApiKey: t });
    toast(r.ok ? '✓ 秘塔 Key 已保存' : '✗ ' + (r.error || '失败'), r.ok ? 'ok' : 'err');
    if (r.ok) { await refresh(); renderSettings(v); }
  });

  const clearMetaso = $('#st-metaso-clear');
  if (clearMetaso) clearMetaso.addEventListener('click', () => {
    openDlg('清除秘塔 Key', '<p style="font-size:13px;color:var(--ink2)">清除后联网检索不可用（agent 会改用其它工具回答）。</p>', '清除', async () => {
      const r = await send('/api/settings', { clearMetaso: true });
      toast(r.ok ? '✓ 秘塔 Key 已清除' : '✗ ' + (r.error || '失败'), r.ok ? 'ok' : 'err');
      if (r.ok) { await refresh(); renderSettings(v); }
      return true;
    });
  });

  $('#st-pref-save').addEventListener('click', async () => {
    const size = Number($('#st-size').value);
    const r = await send('/api/settings', { metasoScope: $('#st-scope').value, searchSize: size });
    toast(r.ok ? '✓ 检索偏好已保存' : '✗ ' + (r.error || '失败'), r.ok ? 'ok' : 'err');
    // ⚠️ 保存偏好后**不重画整页**：用户可能正在下面填令牌，重画会把输入清掉。
    //    偏好不影响本页其它字段的显示。
    if (r.ok) await refresh();
  });
}

PAGES['settings'] = { render: renderSettings };
