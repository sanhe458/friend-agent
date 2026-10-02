/* 页面：memory */
async function renderMemory(v) {
  const ps = ST.state.persons || [];
  const pid = ST.memPick || (ps[0] && ps[0].id) || '';
  const d = pid ? await api('/api/chat?channel=' + encodeURIComponent('qq') + '&externalId=' + encodeURIComponent((ps.find((p) => p.id === pid)?.bindings?.[0]?.externalId) || '')) : {};
  const mem = d.memory || [];
  v.innerHTML =
    '<div class="card sec"><div class="row">' +
      '<span style="font-size:13px;color:var(--ink2)">选择人</span>' +
      '<select id="mem-pick" style="width:280px">' + (ps.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === pid ? ' selected' : '') + '>' + esc(p.id + ' · ' + (p.displayName || '')) + '</option>').join('') || '<option value="">（无人）</option>') + '</select>' +
      '<button class="btn pri" id="mem-add" style="margin-left:auto">新增记忆</button></div></div>' +
    '<div class="card pad0">' + (mem.length ? '<table><thead><tr><th>内容</th><th>标签</th><th>来源</th><th>时间</th><th>热度</th></tr></thead><tbody>' +
      mem.slice().reverse().map((m) => '<tr><td>' + esc(m.text) + '</td><td>' + (m.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join(' ') + '</td>' +
        '<td>' + esc(m.channel || '—') + '</td><td class="mono num" style="font-size:12px;color:var(--ink3)">' + new Date(m.at).toLocaleString('zh-CN') + '</td>' +
        '<td>' + (m.hot ? '<span class="tag on">热</span>' : '<span class="tag">冷</span>') + '</td></tr>').join('') +
      '</tbody></table>' : '<div class="empty">这个人还没有记忆</div>') + '</div>';
  const sel = $('#mem-pick');
  if (sel) sel.addEventListener('change', () => { ST.memPick = sel.value; renderMemory(v); });
  const add = $('#mem-add');
  if (add) add.addEventListener('click', () => {
    openDlg('新增记忆', '<label class="f"><span>内容</span><textarea id="nm-t" rows="3" placeholder="他喜欢…"></textarea></label>', '保存', async () => {
      const r = await send('/api/remember', { personId: pid, text: $('#nm-t').value.trim() });
      toast(r.ok ? '✓ 已记住' : '✗ ' + (r.error || '失败'));
      await refresh(); renderMemory(v); return true;
    });
  });
}

/* ── 通道 ─────────────────────────────── */

PAGES['memory'] = { render: renderMemory };
