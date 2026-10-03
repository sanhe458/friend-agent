/* 页面：memory
 *
 * ⚠️ 2026-10-03 新增「语义召回测试」：输入一句话，看系统实际会召回哪些记忆
 * （配了 embedding/rerank 角色时走向量 + 精排，带分数；没配走关键词）。
 * 这是调记忆系统最直观的入口——召回得准不准，一试便知。
 */
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
    '<div class="card sec"><h3 style="margin:0 0 8px">语义召回测试</h3>' +
      '<p class="hint" style="margin:0 0 8px">拿一句「用户会说的话」试试召回效果——显示实际注入给模型的记忆与打分来源'
      + '（<span class="tag">rerank</span>精排 / <span class="tag">vector</span>向量 / <span class="tag">keyword</span>关键词）。'
      + '没配 embedding 角色时只会有关键词分。</p>' +
      '<div class="row">' +
        '<input id="mem-q" style="flex:1" placeholder="比如：他喜欢吃什么？">' +
        '<button class="btn pri" id="mem-search">召回测试</button>' +
      '</div>' +
      '<div id="mem-search-out" style="margin-top:10px"></div></div>' +
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
  const btn = $('#mem-search');
  if (btn) btn.addEventListener('click', async () => {
    const out = $('#mem-search-out');
    const q = $('#mem-q').value.trim();
    if (!q) { toast('先输入要测的查询'); return; }
    btn.disabled = true; btn.textContent = '召回中…';
    out.innerHTML = '<p class="hint">计算中（向量 + 精排）…</p>';
    try {
      const r = await api('/api/memory/search?personId=' + encodeURIComponent(pid) + '&query=' + encodeURIComponent(q));
      if (r.error) {
        out.innerHTML = '<p class="hint" style="color:var(--warn)">✗ ' + esc(r.error) + '</p>';
      } else {
        const head = '<p class="hint" style="margin:0 0 6px">向量召回 <b>' + (r.vectorRecall ? '✓ ' + esc(r.embeddingModel) : '未配（关键词模式）') +
          '</b>' + (r.vectorRecall ? ' ｜ 精排 <b>' + (r.rerank ? '✓ ' + esc(r.rerankModel) : '未配') + '</b>' : '') + '</p>';
        const rows = (r.hits || []).map((h, i) =>
          '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(h.text) + '</td>' +
          '<td><span class="tag ' + (h.source === 'rerank' ? 'on' : h.source === 'vector' ? 'info' : '') + '">' + esc(h.source) + '</span></td>' +
          '<td class="mono num">' + (typeof h.score === 'number' ? h.score.toFixed(4) : esc(h.score)) + '</td></tr>');
        out.innerHTML = head + (rows.length
          ? '<table><thead><tr><th>#</th><th>记忆</th><th>来源</th><th>分数</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>'
          : '<p class="hint" style="color:var(--warn)">没有召回任何记忆（向量还没算好？稍等几秒再试）</p>');
      }
    } catch (err) {
      out.innerHTML = '<p class="hint" style="color:var(--warn)">✗ ' + esc((err && err.message) || '失败') + '</p>';
    } finally {
      btn.disabled = false; btn.textContent = '召回测试';
    }
  });
}

/* ── 通道 ─────────────────────────────── */

PAGES['memory'] = { render: renderMemory };
