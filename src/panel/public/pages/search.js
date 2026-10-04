/* 页面：search
 * 2026-10-04 升级：范围选择（网页/新闻/学术）、条数、键入 Enter 检索、结果来源域名显示。
 */
function renderSearch(v) {
  v.innerHTML =
    '<div class="card sec"><div class="row">' +
      '<select id="se-scope" style="width:110px">' +
        '<option value="webpage">网页</option><option value="news">新闻</option><option value="paper">学术</option>' +
      '</select>' +
      '<select id="se-size" style="width:100px">' +
        [5, 10, 15].map((n) => '<option value="' + n + '"' + (n === 5 ? ' selected' : '') + '>' + n + ' 条</option>').join('') +
      '</select>' +
      '<input id="se-q" placeholder="搜索…" style="flex:1">' +
      '<button class="btn pri" id="se-go">搜索</button></div>' +
      '<p class="hint" style="margin:8px 0 0">走秘塔（metaso）联网检索——agent 回答「需要查最新资料」的问题时用的就是这条链路。需要配置秘塔 API key（面板设置里可填）。</p></div>' +
    '<div class="card pad0"><div id="se-out"><div class="empty">输入关键词开始检索</div></div></div>';
  const run = async () => {
    const q = $('#se-q').value.trim(); if (!q) return;
    $('#se-out').innerHTML = '<div class="empty">检索中…</div>';
    const r = await send('/api/search', { query: q, scope: $('#se-scope').value, size: Number($('#se-size').value) });
    const items = r.hits || r.results || r.items || [];
    $('#se-out').innerHTML = items.length ? items.map((x) => {
      const link = String(x.link || x.url || '#');
      let host = '';
      try { host = new URL(link).host; } catch { /* ignore */ }
      return '<div class="ev" style="padding:10px 18px"><a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer"><b>' + esc(x.title || link) + '</b></a>' +
        (host ? ' <span class="tag">' + esc(host) + '</span>' : '') +
        (x.date || x.score ? '<span class="tag" style="margin-left:6px">' + esc(x.date || '') + (x.score ? ' · ' + esc(x.score) : '') + '</span>' : '') +
        '<div style="color:var(--ink2);font-size:12.5px;margin-top:3px">' + esc(String(x.summary || x.snippet || '').slice(0, 220)) + '</div></div>';
    }).join('')
      : '<div class="empty">' + esc(r.error || '没有结果') + '</div>';
  };
  $('#se-go').addEventListener('click', run);
  $('#se-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

PAGES['search'] = { render: renderSearch };
