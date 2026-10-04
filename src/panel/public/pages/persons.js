/* 页面：persons
 * 2026-10-04 升级：每行加「对话 / 记忆」快捷跳转；归并发起后可以直接在面板里代回验证码
 * （原来发完码就断了，得自己去另一个对话里手打）。
 */
function renderPersons(v) {
  const ps = ST.state.persons || [];
  v.innerHTML =
    '<div class="card pad0 sec">' + (ps.length ? '<table class="acts"><thead><tr><th>ID</th><th>称呼</th><th>绑定</th><th>惯用通道</th><th>记忆</th><th></th></tr></thead><tbody>' +
      ps.map((p) => '<tr><td class="mono num">' + esc(p.id) + '</td><td><b>' + esc(p.displayName || '—') + '</b></td>' +
        '<td>' + (p.bindings || []).map((b) => '<span class="tag" style="margin-right:4px">' + esc(b.channel + ':' + String(b.externalId).slice(0, 18)) + '</span>').join('') + '</td>' +
        '<td>' + (p.preferredChannel ? '<span class="tag info">' + esc(p.preferredChannel) + '</span>' : '—') + '</td>' +
        '<td class="num">' + ((ST.memCount || {})[p.id] || 0) + '</td>' +
        '<td class="row"><button class="btn sm" data-act="rename" data-id="' + esc(p.id) + '" data-name="' + esc(p.displayName || '') + '">改称呼</button>' +
        '<button class="btn sm" data-act="prefer" data-id="' + esc(p.id) + '">惯用通道</button>' +
        '<button class="btn sm" data-act="tochat" data-id="' + esc(p.id) + '">对话</button>' +
        '<button class="btn sm" data-act="tomem" data-id="' + esc(p.id) + '">记忆</button></td></tr>').join('') +
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
  const findPerson = (id) => ps.find((x) => x.id === id);
  $$('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'rename') {
      const cur = b.getAttribute('data-name') || '';
      openDlg('改称呼',
        '<label class="f"><span>称呼</span><input id="rn-name" value="' + esc(cur) + '" placeholder="比如 三河、小明(QQ)"></label>' +
        '<p class="hint" style="margin:-6px 0 8px">建议重名时加区分后缀，否则 AI 选人会选错。</p>', '保存', async () => {
        const r = await send('/api/person/rename', { personId: id, name: $('#rn-name').value.trim() });
        if (!r.ok) { toast('✗ ' + (r.error || '失败'), 'err'); return false; }
        toast(r.duplicateOf && r.duplicateOf.length ? '✓ 已改（⚠️ 现在有重名）' : '✓ 已改', 'ok');
        await refresh();
        if (TAB === 'persons') render();
        return true;
      });
    } else if (act === 'prefer') {
      const p = findPerson(id) || {};
      const chans = [...new Set(['qq', 'telegram', 'panel'].concat((p.bindings || []).map((x) => x.channel)))];
      openDlg('改惯用通道',
        '<label class="f"><span>通道（回注优先级最高的那个）</span><select id="pf-ch">' +
          '<option value="">（不设，按发起通道回）</option>' +
          chans.map((c) => '<option value="' + esc(c) + '"' + (p.preferredChannel === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
        '</select></label>', '保存', async () => {
        const r = await send('/api/prefer', { personId: id, channel: $('#pf-ch').value.trim() });
        toast(r.ok ? '✓ 已更新' : '✗ ' + (r.error || '失败'), r.ok ? 'ok' : 'err');
        await refresh(); return true;
      });
    } else if (act === 'tochat') {
      const p = findPerson(id) || {};
      const b0 = (p.bindings || [])[0];
      if (!b0) { toast('这个人还没有绑定对话', 'err'); return; }
      try { sessionStorage.setItem('fa_chat_pick', JSON.stringify({ channel: b0.channel, externalId: b0.externalId })); } catch { /* ignore */ }
      go('chat');
    } else if (act === 'tomem') {
      try { sessionStorage.setItem('fa_mem_pick', id); } catch { /* ignore */ }
      go('memory');
    }
  }));
  $('#mg-req').addEventListener('click', async () => {
    const sel = $('#mg-known');
    if (!sel) return;
    const knownKey = sel.value || '';
    const i = knownKey.indexOf('|');
    if (i < 0) { toast('✗ 没有可归并的已有档案', 'err'); return; }
    // from = 发起方（要在它里面回码）；claim = 已存在的那个对话（码发到那里）
    const from = { channel: $('#mg-ch').value.trim(), externalId: $('#mg-ex').value.trim() };
    const claim = { channel: knownKey.slice(0, i), externalId: knownKey.slice(i + 1) };
    if (!from.channel || !from.externalId) { toast('✗ 请填另一个对话', 'err'); return; }
    const r = await send('/api/merge/request', { from, claim });
    if (r.error && !r.code) {
      $('#mg-out').innerHTML = '<div class="ev" style="color:var(--bad)">' + esc(r.error) + '</div>';
      return;
    }
    $('#mg-out').innerHTML =
      '<div class="ev">验证码已发到 <b>' + esc(claim.channel) + '</b> 那个对话。<br>' +
      '接下来要在 <b>' + esc(from.channel + ':' + String(from.externalId).slice(0, 12)) + '</b> 里把 6 位码回给机器人。<br>' +
      '验证码：<b class="mono" style="font-size:15px">' + esc(r.code || '（见已存在对话）') + '</b>（10 分钟内有效）</div>' +
      (r.delivered && r.delivered !== 'ok' ? '<div class="ev" style="color:var(--warn)">码投递失败：' + esc(r.delivered) + '（可以手动去已有对话看，或把码口头转达）</div>' : '') +
      '<div class="row" style="margin-top:10px">' +
        '<input id="mg-code" placeholder="在发起对话回的 6 位码" style="width:190px">' +
        '<button class="btn pri" id="mg-confirm">确认合并</button>' +
        '<span style="color:var(--ink3);font-size:12px">面板代回 = 直接替你在发起对话里验证</span>' +
      '</div>';
    $('#mg-confirm').addEventListener('click', async () => {
      const code = $('#mg-code').value.trim();
      if (!code) { toast('先填验证码', 'err'); return; }
      const r2 = await send('/api/merge/confirm', { code, via: from });
      if (r2.ok) {
        toast('✓ 已合并为 ' + (r2.person && r2.person.id || ''), 'ok');
        $('#mg-out').innerHTML = '<div class="ev" style="color:var(--ok)">✓ 已合并到 <b>' + esc(r2.person && r2.person.id || '') + '</b>（' + esc(r2.person && r2.person.displayName || '') + '）</div>';
        await refresh(); if (TAB === 'persons') render();
      } else {
        toast('✗ ' + (r2.error || '失败'), 'err');
      }
    });
  });
}

PAGES['persons'] = { render: renderPersons };
