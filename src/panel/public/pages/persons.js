/* 页面：persons */
function renderPersons(v) {
  const ps = ST.state.persons || [];
  v.innerHTML =
    '<div class="card pad0 sec">' + (ps.length ? '<table class="acts"><thead><tr><th>ID</th><th>称呼</th><th>绑定</th><th>惯用通道</th><th>记忆</th><th></th></tr></thead><tbody>' +
      ps.map((p) => '<tr><td class="mono num">' + esc(p.id) + '</td><td><b>' + esc(p.displayName || '—') + '</b></td>' +
        '<td>' + (p.bindings || []).map((b) => '<span class="tag" style="margin-right:4px">' + esc(b.channel + ':' + String(b.externalId).slice(0, 18)) + '</span>').join('') + '</td>' +
        '<td>' + (p.preferredChannel ? '<span class="tag info">' + esc(p.preferredChannel) + '</span>' : '—') + '</td>' +
        '<td class="num">' + ((ST.memCount || {})[p.id] || 0) + '</td>' +
        '<td class="row"><button class="btn sm" data-act="rename" data-id="' + esc(p.id) + '" data-name="' + esc(p.displayName || '') + '">改称呼</button>' +
        '<button class="btn sm" data-act="prefer" data-id="' + esc(p.id) + '">改惯用通道</button></td></tr>').join('') +
      '</tbody></table>' : '<div class="empty">还没有识别到任何人</div>') + '</div>' +
    '<div class="card"><h3>跨对话归并</h3>' +
      '<p class="hint">每个对话各自一份档案。要把两个对话认成同一个人：<b>验证码发到已存在的那个对话</b>，然后你要在<b>另一个对话</b>里把它回出来——这样才能证明两边是同一个人在操作。</p>' +
      '<div class="row"><select id="mg-known" style="width:280px">' +
      ps.flatMap((p) => (p.bindings || []).map((b) => '<option value="' + esc(b.channel + '|' + b.externalId) + '">' + esc(p.id + ' ← ' + b.channel + ':' + String(b.externalId).slice(0, 14)) + '</option>')).join('') +
      '</select>' +
      '<input id="mg-ch" placeholder="另一个对话 channel" style="width:150px">' +
      '<input id="mg-ex" placeholder="另一个对话 externalId" style="width:200px">' +
      '<button class="btn" id="mg-req">开始验证</button></div>' +
      '<div id="mg-out" style="margin-top:12px"></div></div>';
  $$('[data-act="rename"]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    const cur = b.getAttribute('data-name') || '';
    openDlg('改称呼',
      '<label class="f"><span>称呼</span><input id="rn-name" value="' + esc(cur) + '" placeholder="比如 三河、小明(QQ)"></label>' +
      '<p class="hint" style="margin:-6px 0 8px">建议重名时加区分后缀，否则 AI 选人会选错。</p>', '保存', async () => {
      const r = await send('/api/person/rename', { personId: id, name: $('#rn-name').value.trim() });
      if (!r.ok) { toast('✗ ' + (r.error || '失败')); return false; }
      toast(r.duplicateOf && r.duplicateOf.length ? '✓ 已改（⚠️ 现在有重名）' : '✓ 已改');
      await refresh();
      renderPersons(v);
      return true;
    });
  }));

  $$('[data-act="prefer"]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    openDlg('改惯用通道', '<label class="f"><span>通道</span><input id="pf-ch" placeholder="qq / telegram / panel"></label>', '保存', async () => {
      const r = await send('/api/prefer', { personId: id, channel: $('#pf-ch').value.trim() });
      toast(r.ok ? '✓ 已更新' : '✗ ' + (r.error || '失败'));
      await refresh(); return true;
    });
  }));
  $('#mg-req').addEventListener('click', async () => {
    const sel = $('#mg-known');
    if (!sel) return;
    const knownKey = sel.value || '';
    const i = knownKey.indexOf('|');
    if (i < 0) { toast('✗ 没有可归并的已有档案'); return; }
    // from = 发起方（要在它里面回码）；claim = 已存在的那个对话（码发到那里）
    const from = { channel: $('#mg-ch').value.trim(), externalId: $('#mg-ex').value.trim() };
    const claim = { channel: knownKey.slice(0, i), externalId: knownKey.slice(i + 1) };
    if (!from.channel || !from.externalId) { toast('✗ 请填另一个对话'); return; }
    const r = await send('/api/merge/request', { from, claim });
    $('#mg-out').innerHTML = r.code
      ? '<div class="ev">验证码已发到 <b>' + esc(claim.channel) + '</b>。<br>请到 <b>' + esc(from.channel + ':' + String(from.externalId).slice(0, 12)) +
        '</b> 那个对话里回 <b class="mono">' + esc(r.code) + '</b> —— 回对了就自动合并。</div>'
      : '<div class="ev" style="color:var(--bad)">' + esc(r.error || '发起失败') + '</div>';
  });
}

/* ── 记忆 ─────────────────────────────── */

PAGES['persons'] = { render: renderPersons };
