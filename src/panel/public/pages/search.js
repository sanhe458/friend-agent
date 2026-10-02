/* 页面：search */
function renderSearch(v) {
  v.innerHTML =
    '<div class="card sec"><div class="row"><input id="se-q" placeholder="搜索…" style="flex:1">' +
      '<button class="btn pri" id="se-go">搜索</button></div></div>' +
    '<div class="card pad0"><div id="se-out"><div class="empty">输入关键词开始检索</div></div></div>';
  const run = async () => {
    const q = $('#se-q').value.trim(); if (!q) return;
    $('#se-out').innerHTML = '<div class="empty">检索中…</div>';
    const r = await send('/api/search', { query: q });
    const items = r.hits || r.results || r.items || [];
    $('#se-out').innerHTML = items.length ? items.map((x) =>
      '<div class="ev" style="padding:10px 18px"><a href="' + esc(x.link || x.url || '#') + '" target="_blank" rel="noopener noreferrer"><b>' + esc(x.title || x.link || '') + '</b></a>' +
      (x.date || x.score ? '<span class="tag" style="margin-left:6px">' + esc(x.date || '') + (x.score ? ' · ' + esc(x.score) : '') + '</span>' : '') +
      '<div style="color:var(--ink2);font-size:12.5px;margin-top:3px">' + esc(String(x.summary || x.snippet || '').slice(0, 220)) + '</div></div>').join('')
      : '<div class="empty">' + esc(r.error || '没有结果') + '</div>';
  };
  $('#se-go').addEventListener('click', run);
  $('#se-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

/* ── 对话 ─────────────────────────────── */

PAGES['search'] = { render: renderSearch };
