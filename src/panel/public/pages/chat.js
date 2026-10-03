/* 页面：chat */
let chatCh = 'qq', chatId = '';
async function renderChat(v) {
  v.innerHTML =
    '<div class="chat"><div class="head">' +
      '<span style="font-size:13px;color:var(--ink2)">通道</span>' +
      '<select id="c-ch" style="width:130px">' + ((ST.runtime.channels || []).map((c) => '<option' + (c === chatCh ? ' selected' : '') + '>' + esc(c) + '</option>').join('')) + '</select>' +
      '<input id="c-id" value="' + esc(chatId) + '" placeholder="externalId" style="width:300px">' +
      '<button class="btn" id="c-open">打开</button><span class="spacer"></span>' +
      '<span id="c-stat" style="font-size:12.5px;color:var(--ink3)"></span></div>' +
      '<div class="stream" id="c-stream"><div class="empty">选择或输入一个 externalId</div></div>' +
      '<div class="foot"><input id="c-text" placeholder="以这个人的身份说一句（会走完整回复链路）">' +
      '<button class="btn pri" id="c-send">发送</button></div></div>' +
      '<div class="hint" id="c-budget" style="margin-top:10px"></div>';
  // 上下文预算放到**静态位置**：以前它是每轮都往对话流里插一条「预算：…」事件，
  // 位置又紧挨着真正压缩的判断，看起来很像“压缩发生了”——其实从来没压过。
  api('/api/models').then((m) => {
    const el = document.getElementById('c-budget');
    if (!el) return;
    const rid = (m.roles || {}).reply;
    const mm = (m.models || []).find((x) => x.id === rid) || {};
    const b = mm.budget || {}, c = m.compression || {};
    const k = (n) => (n ? Math.round(n / 1000) + 'k' : '—');
    el.textContent = `上下文预算（当前回答模型 ${rid || '未设'}）：窗口 ${k(b.contextWindow)} · 触发 ${k(b.triggerAt)} · 压到 ${k(b.targetAt)}`
      + `（比例 ${Math.round((c.triggerRatio ?? 0.75) * 100)}% → ${Math.round((c.targetRatio ?? 0.5) * 100)}%）`
      + '　—— 用满触发线才会压，平时不压。';
  });

  $('#c-open').addEventListener('click', () => { chatCh = $('#c-ch').value; chatId = $('#c-id').value.trim(); tickChat(); });
  $('#c-send').addEventListener('click', async () => {
    const text = $('#c-text').value.trim(); if (!text) return;
    $('#c-text').value = '';
    await send('/api/say', { channel: chatCh, externalId: chatId, text });
    lastChatKey = ''; tickChat();
  });
  $('#c-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#c-send').click(); });
  if (!chatId) { const p = (ST.state.persons || [])[0]; if (p && p.bindings && p.bindings[0]) { chatCh = p.bindings[0].channel; chatId = p.bindings[0].externalId; $('#c-id').value = chatId; $('#c-ch').value = chatCh; } }
  tickChat();
}
let lastChatKey = '';
async function tickChat() {
  if (TAB !== 'chat' || !chatId) return;
  const d = await api('/api/chat?channel=' + encodeURIComponent(chatCh) + '&externalId=' + encodeURIComponent(chatId));
  const evs = d.events || [];
  // ⚠️ running 也要进 key：事件数是 append-only 的（长度变=内容变），但「正在处理」是独立状态，
  //    不计入就会导致这一轮开始时状态标签不刷新（一直显示上一次的“正在处理/已结束”）。
  const key = evs.length + '|' + (d.draft ? d.draft.length : 0) + '|' + (d.running ? 1 : 0);
  $('#c-stat').innerHTML = d.error ? '读取失败' : (d.running ? '<span class="tag warn">正在处理</span>' : (d.person ? '<span class="tag info">' + esc(d.person.id) + '</span>' : '<span class="tag">还没有对话</span>'));
  if (key === lastChatKey) return;
  lastChatKey = key;
  const s = $('#c-stream');
  const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  let html = evs.map((e) => {
    if (e.kind === 'user') return '<div class="m me"><div class="who">对方</div><div class="txt">' + esc(e.text) + '</div></div>';
    if (e.kind === 'assistant') return '<div class="m"><div class="who">小满</div><div class="txt">' + esc(e.text) + '</div></div>';
    if (e.kind === 'tool') return '<div class="ev">⚙ <span class="n">' + esc(e.name) + '</span> ' + esc(String(e.args || '').slice(0, 100)) + (e.error ? ' <span style="color:var(--bad)">失败</span>' : '') + '</div>';
    return '<div class="ev">' + esc(String(e.text || '').slice(0, 160)) + '</div>';
  }).join('');
  if (d.draft) html += '<div class="m live"><div class="who">小满 · 正在说</div><div class="txt">' + esc(d.draft) + '<span class="caret"></span></div></div>';
  s.innerHTML = html || '<div class="empty">还没有对话</div>';
  if (atBottom) s.scrollTop = s.scrollHeight;
}

/* ── 快照与轮询 ───────────────────────── */

PAGES['chat'] = { render: renderChat };
