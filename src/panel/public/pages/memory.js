/* 页面：memory
 *
 * 2026-10-03 新增「语义召回测试」：输入一句话，看系统实际会召回哪些记忆
 * （配了 embedding/rerank 角色时走向量 + 精排，带分数；没配走关键词）。
 * 2026-10-04 升级：改用 /api/memory 全量接口（原来借 /api/chat 只拿最近 30 条）、
 *   加删除按钮（POST /api/memory/delete）、文本过滤、总数显示、
 *   支持从「人 / 身份」页带 fa_mem_pick 直接定位。
 */
async function renderMemory(v) {
  const ps = ST.state.persons || [];
  const pick = (() => { try { const x = sessionStorage.getItem('fa_mem_pick'); sessionStorage.removeItem('fa_mem_pick'); return x; } catch (e) { return null; } })();
  const pid = ST.memPick || pick || (ps[0] && ps[0].id) || '';
  const d = pid ? await api('/api/memory?personId=' + encodeURIComponent(pid)) : {};
  // ⚠️ async 渲染的通病：await 期间用户切走页面的话，v 已经不属于当前视图了，
  //    继续写 innerHTML 会把新页面盖掉（实测：从记忆页切走时偶发整页串台）。
  if (TAB !== 'memory' || v !== document.getElementById('view')) return;
  const mem = d.items || [];
  const total = mem.length;
  v.innerHTML =
    '<div class="card sec"><div class="row">' +
      '<span style="font-size:13px;color:var(--ink2)">选择人</span>' +
      '<select id="mem-pick" style="width:280px">' + (ps.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === pid ? ' selected' : '') + '>' + esc(p.id + ' · ' + (p.displayName || '')) + '</option>').join('') || '<option value="">（无人）</option>') + '</select>' +
      '<span class="tag">' + total + ' 条</span>' +
      '<input id="mem-filter" placeholder="过滤：输入关键词…" style="width:200px">' +
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
    '<div class="card pad0"><div id="mem-table">' +
      (total ? memoryTable(mem.slice().reverse(), '') : '<div class="empty">' + (pid ? '这个人还没有记忆' : '先在上方选择一个人') + '</div>') +
    '</div></div>';
  const sel = $('#mem-pick');
  if (sel) sel.addEventListener('change', () => { ST.memPick = sel.value; renderMemory(v); });
  const filterEl = $('#mem-filter');
  filterEl.addEventListener('input', () => {
    const q = filterEl.value.trim().toLowerCase();
    const rows = mem.slice().reverse().filter((m) => !q || String(m.text).toLowerCase().includes(q));
    $('#mem-table').innerHTML = rows.length ? memoryTable(rows, q)
      : '<div class="empty">' + (q ? '没有匹配「' + esc(q) + '」的记忆' : '这个人还没有记忆') + '</div>';
    bindDel();
  });
  const add = $('#mem-add');
  if (add) add.addEventListener('click', () => {
    openDlg('新增记忆', '<label class="f"><span>内容</span><textarea id="nm-t" rows="3" placeholder="他喜欢…"></textarea></label>', '保存', async () => {
      const r = await send('/api/remember', { personId: pid, text: $('#nm-t').value.trim() });
      toast(r.ok ? '✓ 已记住' : '✗ ' + (r.error || '失败'), r.ok ? 'ok' : 'err');
      await refresh(); renderMemory(v); return true;
    });
  });
  const btn = $('#mem-search');
  if (btn) btn.addEventListener('click', async () => {
    const out = $('#mem-search-out');
    const q = $('#mem-q').value.trim();
    if (!q) { toast('先输入要测的查询', 'err'); return; }
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

  function memoryTable(list) {
    return '<table><thead><tr><th>内容</th><th>标签</th><th>来源</th><th>时间</th><th>热度</th><th></th></tr></thead><tbody>' +
      list.map((m) => '<tr><td>' + esc(m.text) + '</td>' +
        '<td>' + (m.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join(' ') + '</td>' +
        '<td>' + esc(m.channel || '—') + '</td>' +
        '<td class="mono num" style="font-size:12px;color:var(--ink3)">' + fmtDateTime(m.at) + '</td>' +
        '<td>' + (m.hot ? '<span class="tag on">热</span>' : '<span class="tag">冷</span>') + '</td>' +
        '<td class="row"><button class="btn sm danger" data-del="' + esc(String(m.id)) + '">删除</button></td></tr>').join('') +
      '</tbody></table>';
  }
  function bindDel() {
    $$('#mem-table [data-del]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.getAttribute('data-del'));
      const item = mem.find((x) => Number(x.id) === id);
      openDlg('删除记忆',
        '<p style="font-size:13px;color:var(--ink2)">确定删除这条记忆？删掉后 AI 就不会再想起它。</p>' +
        '<div class="ev">' + esc(item ? item.text : '#' + id) + '</div>', '删除', async () => {
        const r = await send('/api/memory/delete', { personId: pid, id });
        toast(r.ok ? '✓ 已删除' : '✗ ' + (r.error || '失败'), r.ok ? 'ok' : 'err');
        await refresh(); renderMemory(v); return true;
      });
    }));
  }
  bindDel();
}

PAGES['memory'] = { render: renderMemory };
