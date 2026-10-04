/* 页面：对话
 *
 * 2026-10-04 重做（原来是个毛坯：手输 externalId、消息无时间、工具调用一行带过）：
 *   ① 对象下拉：从「人 / 身份」带出所有绑定，不用再背 externalId
 *   ② 消息带时间戳；工具调用折叠展开看参数/返回（对齐独立对话页的体验）
 *   ③ 「翻篇」按钮 = 发 /new 命令（归档上下文 + 干净开局）
 *   ④ 输入框自动增高（Enter 发送，Shift+Enter 换行）
 *   ⑤ 导出当前对话为 txt
 *   ⑥ 状态条：personId / 记忆数 / 任务数
 */
let chatCh = 'qq', chatId = '';

async function renderChat(v) {
  const persons = ST.state.persons || [];
  // 恢复上次选过的对象（本页自己的记忆，不进全局 ST）
  const last = (() => { try { return JSON.parse(sessionStorage.getItem('fa_chat_pick') || 'null'); } catch (e) { return null; } })();
  if (last && last.externalId) { chatCh = last.channel || chatCh; chatId = last.externalId; }
  if (!chatId) { const p = persons[0]; if (p && p.bindings && p.bindings[0]) { chatCh = p.bindings[0].channel; chatId = p.bindings[0].externalId; } }

  const opts = persons.flatMap((p) => (p.bindings || []).map((b) =>
    '<option value="' + esc(b.channel + '|' + b.externalId) + '"'
    + (b.channel === chatCh && String(b.externalId) === String(chatId) ? ' selected' : '') + '>'
    + esc((p.displayName || p.id) + ' · ' + b.channel + ':' + String(b.externalId).slice(0, 20)) + '</option>')).join('');

  v.innerHTML =
    '<div class="chat"><div class="head">' +
      '<select id="c-person" style="width:260px"' + (opts ? '' : ' disabled') + '>' +
        (opts || '<option value="">（还没有任何人）</option>') + '</select>' +
      '<input id="c-ch" value="' + esc(chatCh) + '" placeholder="channel" style="width:110px" title="通道（可手输，会跟下拉联动）">' +
      '<input id="c-id" value="' + esc(chatId) + '" placeholder="externalId" style="width:170px" title="externalId（可手输）">' +
      '<button class="btn sm" id="c-open">打开</button>' +
      '<span class="spacer"></span>' +
      '<span class="stat" id="c-stat"></span>' +
      '<button class="btn sm" id="c-new" title="发送 /new：归档当前上下文并干净开局">翻篇</button>' +
      '<button class="btn sm" id="c-export" title="把当前对话导出为 txt 下载">导出</button>' +
    '</div>' +
    '<div class="stream" id="c-stream"><div class="empty">选择对象后打开对话</div></div>' +
    '<div class="foot"><textarea id="c-text" rows="1" placeholder="以这个人的身份说一句（Enter 发送 · Shift+Enter 换行 · / 开头走命令）"></textarea>' +
    '<button class="btn pri" id="c-send" style="height:40px">发送</button></div></div>' +
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

  const syncPick = () => {
    chatCh = $('#c-ch').value.trim() || 'qq';
    chatId = $('#c-id').value.trim();
    try { sessionStorage.setItem('fa_chat_pick', JSON.stringify({ channel: chatCh, externalId: chatId })); } catch { /* ignore */ }
  };
  $('#c-person').addEventListener('change', (e) => {
    const val = e.target.value || '';
    const i = val.indexOf('|');
    if (i >= 0) { $('#c-ch').value = val.slice(0, i); $('#c-id').value = val.slice(i + 1); }
    syncPick(); lastChatKey = ''; tickChat();
  });
  $('#c-open').addEventListener('click', () => { syncPick(); lastChatKey = ''; tickChat(); });
  $('#c-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#c-open').click(); });

  const ta = $('#c-text');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#c-send').click(); } });

  $('#c-send').addEventListener('click', async () => {
    const text = ta.value.trim(); if (!text || !chatId) { if (!chatId) toast('先选一个对象', 'err'); return; }
    ta.value = ''; ta.style.height = 'auto';
    await send('/api/say', { channel: chatCh, externalId: chatId, text });
    lastChatKey = ''; tickChat();
  });

  $('#c-new').addEventListener('click', async () => {
    if (!chatId) { toast('先选一个对象', 'err'); return; }
    openDlg('翻篇（手动提前归档）',
      '<p style="font-size:13px;color:var(--ink2)">会给这个对话发一条 <b class="mono">/new</b>：当前上下文会归档落盘、摘要提炼进记忆，然后干净开局。进行中的回复不受影响。</p>',
      '翻篇', async () => {
        await send('/api/say', { channel: chatCh, externalId: chatId, text: '/new' });
        toast('✓ 已发 /new', 'ok');
        lastChatKey = ''; setTimeout(tickChat, 600);
        return true;
      });
  });

  $('#c-export').addEventListener('click', () => {
    const evs = lastEvents || [];
    if (!evs.length) { toast('这个对话还没有内容', 'err'); return; }
    const lines = evs.map((e) => {
      const t = e.at ? new Date(e.at).toLocaleString('zh-CN', { hour12: false }) : '';
      if (e.kind === 'user') return `[${t}] 对方：${e.text}`;
      if (e.kind === 'assistant') return `[${t}] 小满：${e.text}`;
      if (e.kind === 'tool') return `[${t}] 工具 ${e.name}(${e.args || ''})${e.error ? ' 失败' : ''} → ${String(e.result || '').slice(0, 300)}`;
      return `[${t}] ${e.text || ''}`;
    });
    const head = `friend-agent 对话导出\n对象：${chatCh}:${chatId}${lastPersonLabel ? '（' + lastPersonLabel + '）' : ''}\n共 ${evs.length} 条事件\n${'—'.repeat(24)}\n`;
    const blob = new Blob([head + lines.join('\n\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `对话_${chatCh}_${chatId}_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('✓ 已导出', 'ok');
  });

  tickChat();
}

let lastChatKey = '';
let lastEvents = null, lastPersonLabel = '';
async function tickChat() {
  if (TAB !== 'chat' || !chatId) return;
  const d = await api('/api/chat?channel=' + encodeURIComponent(chatCh) + '&externalId=' + encodeURIComponent(chatId));
  if (document.getElementById('c-id') === null) return; // 已切走页面
  const evs = d.events || [];
  lastEvents = evs;
  lastPersonLabel = d.person ? (d.person.displayName || d.person.id) : '';
  // ⚠️ running 也要进 key：事件数是 append-only 的（长度变=内容变），但「正在处理」是独立状态，
  //    不计入就会导致这一轮开始时状态标签不刷新（一直显示上一次的“正在处理/已结束”）。
  const key = evs.length + '|' + (d.draft ? d.draft.length : 0) + '|' + (d.running ? 1 : 0);
  const stat = $('#c-stat');
  if (stat) {
    stat.innerHTML = d.error ? '<span class="tag off">读取失败</span>'
      : (d.running ? '<span class="tag warn">正在处理</span>' : '')
      + (d.person ? '<span class="tag info">' + esc(d.person.displayName || d.person.id) + '</span>' : '<span class="tag">新对话</span>')
      + '<span class="tag">' + (d.memory || []).length + ' 条记忆</span>'
      + '<span class="tag">' + (d.tasks || []).length + ' 个任务</span>';
  }
  if (key === lastChatKey) return;
  lastChatKey = key;
  const s = $('#c-stream');
  const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  const pretty = (x) => { try { return JSON.stringify(JSON.parse(x), null, 2); } catch { return String(x ?? ''); } };
  let html = evs.map((e) => {
    const when = e.at ? '<span class="when">' + fmtTime(e.at) + '</span>' : '';
    if (e.kind === 'user') return '<div class="m me"><div class="who">对方' + when + '</div><div class="txt">' + esc(e.text) + '</div></div>';
    if (e.kind === 'assistant') return '<div class="m"><div class="who">小满' + when + '</div><div class="txt">' + esc(e.text) + '</div></div>';
    if (e.kind === 'tool') {
      return '<details class="tool' + (e.error ? ' bad' : '') + '"><summary>'
        + '<span class="fn">⚙ ' + esc(e.name) + '</span>'
        + '<span class="ms">' + (e.error ? '<span style="color:var(--bad)">失败</span> · ' : '')
        + (typeof e.ms === 'number' ? e.ms + 'ms · ' : '') + (e.at ? fmtTime(e.at) : '') + '</span></summary>'
        + '<div class="bd"><div class="lb">参数</div><pre>' + esc(pretty(e.args)) + '</pre>'
        + (e.result !== undefined ? '<div class="lb">返回</div><pre>' + esc(pretty(e.result)) + '</pre>' : '')
        + '</div></details>';
    }
    return '<div class="ev">' + esc(String(e.text || '').slice(0, 200)) + '</div>';
  }).join('');
  if (d.draft) html += '<div class="m live"><div class="who">小满 · 正在说</div><div class="txt">' + esc(d.draft) + '<span class="caret"></span></div></div>';
  s.innerHTML = html || '<div class="empty">还没有对话。在下面输入一句，就会以这个人的身份走完整回复链路。</div>';
  if (atBottom) s.scrollTop = s.scrollHeight;
}

PAGES['chat'] = { render: renderChat };
