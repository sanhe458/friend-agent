/* 页面：roles
 *
 * ⚠️ 2026-10-02 变更（三河）：对话角色与语音角色**分开**。
 *   - 之前：只有 reply/main/sub，而且下拉**不过滤** → 对话角色能选到 ASR 模型；
 *     同时 ASR 根本没有"角色"可配（后端是「取第一个 kind=asr 的模型」）。
 *   - 现在：新增 asr 角色；下拉按模型类型过滤（对话角色只列 chat，asr 只列 asr）。
 *     服务端也会校验类型，填错直接拒。
 */
async function renderRoles(v) {
  const d = await api('/api/models');
  const r = d.roles || {};
  const c = d.compression || {};
  const mods = d.models || [];
  const kindOf = (m) => m.kind || 'chat';
  const chatMods = mods.filter((m) => kindOf(m) === 'chat');
  const asrMods = mods.filter((m) => kindOf(m) === 'asr');

  const rv = {};
  (d.resolved || []).forEach((x) => { rv[x.role] = x; });
  const order = ['reply', 'main', 'sub', 'asr'];
  const resLine = order.some((k) => rv[k] && rv[k].model)
    ? '<div class="ev" style="margin-top:10px">当前生效：' + order
        .filter((k) => rv[k] && rv[k].model)
        .map((k) => esc(k) + ' → <b class="mono">' + esc(rv[k].id || rv[k].model) + '</b>').join(' ｜ ') + '</div>'
    : '';

  // 一行角色下拉：pool 是该角色**允许**的模型池
  const roleRow = (k, label, hint, pool) => {
    const cur = r[k] || '';
    const inPool = pool.some((m) => m.id === cur);
    const extra = cur && !inPool
      ? '<option value="' + esc(cur) + '" selected>' + esc(cur) + '（已不在列表或类型不符）</option>' : '';
    const opts = pool.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>'
      + esc((m.label || m.id) + '  ·  ' + (m.providerId || '') + '/' + (m.model || '')) + '</option>').join('');
    return '<label class="f"><span>' + esc(label) + '</span>' +
      '<select id="rl-' + k + '"><option value="">（不设）</option>' + extra + opts + '</select>' +
      (hint ? '<span class="hint" style="display:block;margin-top:4px">' + esc(hint) + '</span>' : '') + '</label>';
  };

  v.innerHTML =
    '<div class="card sec"><h3>对话角色 → 模型</h3>' +
      '<p class="hint">回复引擎用小模型（快）；后台主智能体负责提炼长期记忆；子 agent 默认模型。<br>' +
      '<b>这里只列「对话(chat)」类型的模型</b>——语音转文字不在这配。</p>' +
      roleRow('reply', 'reply · 前台回复', '', chatMods) +
      roleRow('main', 'main · 后台主智能体', '', chatMods) +
      roleRow('sub', 'sub · 子 agent', '', chatMods) +
      (chatMods.length ? '' : '<p class="hint" style="color:var(--warn)">还没有 chat 类型的模型，先去「模型与服务商」页添加。</p>') +
      resLine +
      '<div class="row end"><button class="btn pri" id="rl-save">保存</button></div></div>' +
    '<div class="card sec"><h3>语音角色 → 模型</h3>' +
      '<p class="hint">用户发语音时用它转文字（<b>ASR</b>，语音转文字）。<br>' +
      '只有「类型 = asr」的模型能被选中；没配就退回列表里第一个 asr 模型。</p>' +
      roleRow('asr', 'asr · 语音转文字', '', asrMods) +
      (asrMods.length
        ? ''
        : '<p class="hint" style="color:var(--warn)">还没有 asr 类型的模型。'
          + '去「模型与服务商」页新增一个，把<b>类型</b>选成 <b>asr</b>（比如 whisper 系的模型）。</p>') +
      '</div>' +
    '<div class="card"><h3>上下文压缩</h3>' +
      '<p class="hint">超过“触发比例”就压到“目标比例”，保留最近若干轮原文。</p>' +
      '<div class="grid g3">' +
        '<label class="f"><span>触发比例</span><input id="cp-t" type="number" step="0.05" value="' + (c.triggerRatio ?? 0.75) + '"></label>' +
        '<label class="f"><span>目标比例</span><input id="cp-g" type="number" step="0.05" value="' + (c.targetRatio ?? 0.5) + '"></label>' +
        '<label class="f"><span>保留最近轮数</span><input id="cp-k" type="number" value="' + (c.keepRecentTurns ?? 8) + '"></label>' +
      '</div><div class="row end"><button class="btn pri" id="cp-save">保存</button></div></div>';

  $('#rl-save').addEventListener('click', async () => {
    const pick = (k) => { const e = $('#rl-' + k); return e ? e.value.trim() : ''; };
    const r2 = await send('/api/roles', { reply: pick('reply'), main: pick('main'), sub: pick('sub'), asr: pick('asr') });
    toast(r2.ok ? '✓ 已保存' : '✗ ' + (r2.error || '失败'));
    if (r2.ok) { await refresh(); render(); }
  });
  $('#cp-save').addEventListener('click', async () => {
    const r2 = await send('/api/compression', { triggerRatio: Number($('#cp-t').value), targetRatio: Number($('#cp-g').value), keepRecentTurns: Number($('#cp-k').value) });
    toast(r2.ok ? '✓ 已保存' : '✗ ' + (r2.error || '失败')); await refresh();
  });
}

/* ── 工具 ─────────────────────────────── */

PAGES['roles'] = { render: renderRoles };
