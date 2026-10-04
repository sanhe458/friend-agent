/* 页面：models
 *
 * ⚠️ 2026-10-02 恢复：此前改版前端时**丢了三样功能**——
 *   ① 模型的「编辑」（含元数据：上下文窗口/最大输出/能力/价格/元数据端点）
 *   ② 单个模型的「取元数据」
 *   ③ 表头的「全部取元数据」
 *   服务端接口一直都在（POST /api/models 支持新建与更新；/api/models/fetch-meta 支持单个与全部），
 *   纯粹是页面没了入口。这里按旧实现原样补回。
 */
async function renderModels(v) {
  const d = await api('/api/models');
  if (TAB !== 'models' || v !== document.getElementById('view')) return; // await 期间切走了
  if (d.error) { v.innerHTML = '<div class="empty">读取失败</div>'; return; }
  const provs = d.providers || [], mods = d.models || [];

  v.innerHTML =
    '<div class="card pad0 sec"><div class="row" style="padding:16px 18px 12px"><h3 style="margin:0">服务商</h3>' +
      '<span class="spacer"></span><button class="btn sm" id="pv-import">从 OpenClaw 导入</button>' +
      '<button class="btn pri sm" id="pv-add">+ 新增服务商</button></div>' +
      (provs.length ? '<table class="acts"><thead><tr><th>ID</th><th>名称</th><th>Base URL</th><th>密钥</th><th></th></tr></thead><tbody>' +
        provs.map((p) => '<tr><td class="mono num">' + esc(p.id) + '</td><td><b>' + esc(p.label || p.name || '') + '</b></td>' +
          '<td class="mono" style="font-size:12px;color:var(--ink3)">' + esc(String(p.baseUrl || '').slice(0, 42)) + '</td>' +
          '<td>' + (p.hasKey ? '<span class="tag on">已配置</span>' : '<span class="tag off">无</span>') + '</td>' +
          '<td class="row"><button class="btn sm" data-act="pv-edit" data-id="' + esc(p.id) + '">编辑</button>' +
          '<button class="btn sm danger" data-act="pv-del" data-id="' + esc(p.id) + '">删除</button></td></tr>').join('') +
        '</tbody></table>' : '<div class="empty">还没有服务商</div>') + '</div>' +
    '<div class="card pad0 sec"><div class="row" style="padding:16px 18px 12px"><h3 style="margin:0">模型</h3>' +
      '<span class="spacer"></span><button class="btn sm" id="md-meta-all">全部取元数据</button>' +
      '<button class="btn pri sm" id="md-add">+ 新增模型</button></div>' +
      (mods.length ? '<table class="acts"><thead><tr><th>显示名</th><th>类型</th><th>provider/model</th><th>上下文</th><th>最大输出</th><th>能力 / 来源</th><th></th></tr></thead><tbody>' +
        mods.map((m) => {
          const b = m.budget || {}, meta = m.meta || {};
          const ctx = b.contextWindow || meta.contextWindow || 0;
          const out = b.maxOutput || meta.maxOutput || 0;
          const kind = m.kind || 'chat';
          const caps = [meta.vision ? '视觉' : '', meta.tools ? '工具' : '', meta.streaming ? '流式' : ''].filter(Boolean)
            .map((x) => '<span class="tag">' + x + '</span>').join(' ');
          const src = meta.source ? '<span class="tag ' + (meta.note ? 'warn' : '') + '">' + esc(meta.source) + (meta.note ? '·' + esc(String(meta.note).slice(0, 14)) : '') + '</span>' : '';
          return '<tr><td><b>' + esc(m.label || m.id) + '</b><div class="mono" style="font-size:11px;color:var(--ink3)">' + esc(m.id) + '</div></td>' +
            '<td>' + (kind === 'chat' ? '<span class="tag">对话</span>' : '<span class="tag info">' + esc(String(kind).toUpperCase()) + '</span>') + '</td>' +
            '<td class="mono" style="font-size:12px">' + esc((m.providerId || '') + '/' + (m.model || '')) + '</td>' +
            '<td class="num">' + (ctx ? Math.round(ctx / 1000) + 'k' : '—') + '</td>' +
            '<td class="num">' + (out ? Math.round(out / 1000) + 'k' : '—') + '</td>' +
            '<td>' + (caps + ' ' + src).trim() + '</td>' +
            '<td class="row"><button class="btn sm" data-act="md-meta" data-id="' + esc(m.id) + '">取元数据</button>' +
            '<button class="btn sm" data-act="md-test" data-id="' + esc(m.id) + '">测试</button>' +
            '<button class="btn sm" data-act="md-edit" data-id="' + esc(m.id) + '">编辑</button>' +
            '<button class="btn sm danger" data-act="md-del" data-id="' + esc(m.id) + '">删除</button></td></tr>';
        }).join('') +
        '</tbody></table>' : '<div class="empty">还没有模型</div>') + '</div>';

  $$('[data-act]').forEach((b) => b.addEventListener('click', () => modelAct(b.getAttribute('data-act'), b.getAttribute('data-id'), provs, mods)));

  // 这几个按钮不是 [data-act]，单独绑
  const pvAdd = $('#pv-add');
  if (pvAdd) pvAdd.addEventListener('click', () => modelAct('pv-add', '', provs, mods));

  const mdAdd = $('#md-add');
  if (mdAdd) mdAdd.addEventListener('click', () => {
    if (!provs.length) { toast('请先添加一个服务商'); return; }
    modelDialog(provs, null);
  });

  const pvImp = $('#pv-import');
  if (pvImp) pvImp.addEventListener('click', async () => {
    const oc = await api('/api/openclaw/providers');
    const list = oc.providers || [];
    if (!list.length) { toast('OpenClaw 里没有可导入的服务商'); return; }
    const already = provs.map((p) => p.id);
    openDlg('从 OpenClaw 导入服务商',
      '<label class="f"><span>选一个（只搬 Base URL 和密钥）</span><select id="im-id">' +
        list.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.id) + ' ─ ' + esc(x.baseUrl) + (x.hasKey ? ' ─ 有密钥' : ' ─ 无密钥') + (already.includes(x.id) ? '（已存在，会覆盖）' : '') + '</option>').join('') +
      '</select></label>' +
      '<p class="hint" style="margin:-6px 0 8px">导入后写进 config.local.json（0600、已 gitignore）。</p>', '导入', async () => {
      const r = await send('/api/providers/import', { providerId: $('#im-id').value });
      toast(r.ok ? '✓ 已导入' : '✗ ' + (r.error || '失败'));
      if (r.ok) { await refresh(); render(); }
      return r.ok;
    });
  });

  // ⭐ 全部取元数据（旧版有，改版时丢了）
  const metaAll = $('#md-meta-all');
  if (metaAll) metaAll.addEventListener('click', async () => {
    if (!mods.length) { toast('还没有模型'); return; }
    const old = metaAll.textContent;
    metaAll.disabled = true; metaAll.textContent = '获取中…';
    try {
      const r = await send('/api/models/fetch-meta', {});
      const rs = r.results || [];
      const bad = rs.filter((x) => !x.ok);
      toast(bad.length
        ? `部分失败 ${bad.length}/${rs.length}：` + bad.map((x) => x.id + '(' + x.error + ')').join('、').slice(0, 90)
        : `✓ 已取到 ${rs.length} 个模型的元数据`);
    } catch (err) {
      toast('✗ ' + (err && err.message ? err.message : '失败'));
    } finally {
      metaAll.disabled = false; metaAll.textContent = old;
      await refresh(); render();
    }
  });
}

/** 新增 / 编辑模型 —— 含元数据（旧版的完整字段） */
function modelDialog(provs, existing) {
  const editing = Boolean(existing);
  const m = existing || {};
  const meta = m.meta || {};
  const numVal = (v) => (v === undefined || v === null || v === '' ? '' : String(v));
  const ck = (v) => (v ? ' checked' : '');

  openDlg(editing ? '编辑模型' : '新增模型',
    '<label class="f"><span>ID（唯一键' + (editing ? '，不可改' : '；角色引用它') + '）</span>' +
      '<input id="m-id" value="' + esc(m.id || '') + '"' + (editing ? ' readonly' : '') + ' placeholder="fast"></label>' +
    '<label class="f"><span>服务商</span><select id="m-prov">' +
      provs.map((p, i) => {
        // 未命中任何服务商时（老数据 providerId 为空或已删）默认选第一个，
        // 否则浏览器默认选第一个但用户毫无察觉，保存会静默改错服务商。
        const sel = m.providerId ? m.providerId === p.id : i === 0;
        return '<option value="' + esc(p.id) + '"' + (sel ? ' selected' : '') + '>' + esc(p.id) + '</option>';
      }).join('') +
    '</select></label>' +
    '<label class="f"><span>真实模型名（发给 API 的那个）</span><input id="m-model" value="' + esc(m.model || '') + '" placeholder="deepseek-chat"></label>' +
    '<label class="f"><span>类型</span><select id="m-kind">' +
      ['chat:对话/推理（默认）', 'asr:语音转文字（收语音时用）', 'tts:文字转语音（预留）', 'vision:图像理解（预留）', 'embedding:向量（记忆语义召回）', 'rerank:重排序（记忆召回精排）']
        .map((x) => { const [v, t] = x.split(':'); return '<option value="' + v + '"' + ((m.kind || 'chat') === v ? ' selected' : '') + '>' + v + ' ─ ' + t + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="f"><span>显示名</span><input id="m-label" value="' + esc(m.label || '') + '" placeholder="留空 = 用模型名"></label>' +
    '<div class="hint" style="margin:6px 0 4px">— 元数据（算上下文压缩预算用）—</div>' +
    '<label class="f"><span>上下文窗口 (tokens)</span><input id="m-ctx" type="number" value="' + numVal(meta.contextWindow) + '"></label>' +
    '<label class="f"><span>最大输出 (tokens)</span><input id="m-out" type="number" value="' + numVal(meta.maxOutput) + '"></label>' +
    '<label class="f"><span>能力</span><span class="row" style="gap:16px">' +
      '<label class="row" style="gap:6px;margin:0"><input type="checkbox" id="m-vision" style="width:auto"' + ck(meta.vision) + '> 视觉</label>' +
      '<label class="row" style="gap:6px;margin:0"><input type="checkbox" id="m-tools" style="width:auto"' + ck(meta.tools) + '> 工具</label>' +
      '<label class="row" style="gap:6px;margin:0"><input type="checkbox" id="m-stream" style="width:auto"' + ck(meta.streaming) + '> 流式</label>' +
    '</span></label>' +
    '<label class="f"><span>价格 /1M tokens（输入 / 输出）</span><span class="row" style="gap:10px">' +
      '<input id="m-pin" type="number" step="0.01" value="' + numVal(meta.inputPrice) + '" placeholder="输入">' +
      '<input id="m-pout" type="number" step="0.01" value="' + numVal(meta.outputPrice) + '" placeholder="输出">' +
    '</span></label>' +
    '<label class="f"><span>元数据端点（可选，留空 = 自动探测 /models）</span><input id="m-metaurl" value="' + esc(m.metaUrl || '') + '"></label>' +
    '<div class="row"><button class="btn sm" id="m-fetch">从服务商取元数据</button>' +
      '<span class="hint" id="m-fetch-msg" style="margin:0"></span></div>',
    '保存', async () => {
      const id = $('#m-id').value.trim();
      const model = $('#m-model').value.trim();
      if (!id) { toast('✗ 请填 ID'); return false; }
      if (!model) { toast('✗ 请填真实模型名'); return false; }
      const numOrU = (sel) => {
        const s = $(sel);
        if (!s) return undefined;
        const v = s.value.trim();
        if (v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined; // NaN/Infinity 一律当未填，避免污染预算计算
      };
      const body = {
        id,
        providerId: $('#m-prov').value,
        model,
        kind: $('#m-kind').value,
        label: $('#m-label').value.trim() || model,
        meta: {
          contextWindow: numOrU('#m-ctx'),
          maxOutput: numOrU('#m-out'),
          vision: $('#m-vision').checked,
          tools: $('#m-tools').checked,
          streaming: $('#m-stream').checked,
          inputPrice: numOrU('#m-pin'),
          outputPrice: numOrU('#m-pout'),
        },
        metaUrl: $('#m-metaurl').value.trim(),
      };
      const r = await send('/api/models', body);
      if (!r.ok) { toast('✗ ' + (r.error || '失败')); return false; }
      toast('✓ 已保存');
      await refresh(); render(); return true;
    });

  // ⭐ 弹窗内「从服务商取元数据」——旧版有，改版时丢了
  const fetchBtn = $('#m-fetch');
  if (fetchBtn) fetchBtn.addEventListener('click', async () => {
    const msg = $('#m-fetch-msg');
    const modelName = $('#m-model').value.trim();
    if (!modelName) { msg.textContent = '先填真实模型名'; return; }
    msg.textContent = '获取中…';
    try {
      const r = await send('/api/models/fetch-meta', {
        providerId: $('#m-prov').value, modelName, metaUrl: $('#m-metaurl').value.trim(),
      });
      const one = (r.results || [])[0] || {};
      if (!one.ok) { msg.textContent = '✗ ' + (one.error || '失败'); return; }
      const mm = one.meta || {};
      const setv = (sel, v) => { const e = $(sel); if (e && v !== undefined && v !== null) e.value = v; };
      const setc = (sel, v) => { const e = $(sel); if (e && v !== undefined) e.checked = Boolean(v); };
      setv('#m-ctx', mm.contextWindow); setv('#m-out', mm.maxOutput);
      setc('#m-vision', mm.vision); setc('#m-tools', mm.tools); setc('#m-stream', mm.streaming);
      setv('#m-pin', mm.inputPrice); setv('#m-pout', mm.outputPrice);
      msg.textContent = '✓ 已从 ' + (one.from || '服务商') + ' 取到，记得点保存写入';
    } catch (err) {
      msg.textContent = '✗ ' + (err && err.message ? err.message : '失败');
    }
  });
}

async function modelAct(act, id, provs, mods) {
  if (act === 'pv-del') {
    openDlg('删除服务商', '<p style="font-size:13px;color:var(--ink2)">将同时影响引用它的模型。确定删除 <b class="mono">' + esc(id) + '</b>？</p>', '删除', async () => {
      const r = await send('/api/providers/delete', { id }); toast(r.ok ? '✓ 已删除' : '✗ ' + (r.error || '失败'));
      await refresh(); render(); return true;
    });
    return;
  }
  if (act === 'pv-edit' || act === 'pv-add') {
    const p = provs.find((x) => x.id === id) || {};
    const editing = act === 'pv-edit';
    openDlg(editing ? '编辑服务商' : '新增服务商',
      '<label class="f"><span>ID（唯一键' + (editing ? '，不可改' : '') + '）</span><input id="p-id" value="' + esc(p.id || '') + '"' + (editing ? ' readonly' : '') + '></label>' +
      '<label class="f"><span>显示名称</span><input id="p-name" value="' + esc(p.label || p.name || '') + '"></label>' +
      '<label class="f"><span>Base URL</span><input id="p-url" value="' + esc(p.baseUrl || '') + '" placeholder="https://…/v1"></label>' +
      '<label class="f"><span>API Key（留空 = 不改）</span><input id="p-key" type="password" placeholder="' + (p.hasKey ? '已配置' : 'sk-…') + '"></label>', '保存', async () => {
        const body = { id: $('#p-id').value.trim(), label: $('#p-name').value.trim(), baseUrl: $('#p-url').value.trim() };
        body['api' + 'Key'] = $('#p-key').value;
        const r = await send('/api/providers', body); toast(r.ok ? '✓ 已保存' : '✗ ' + (r.error || '失败'));
        await refresh(); render(); return true;
      });
    return;
  }
  // ⭐ 编辑模型（含元数据）——旧版有，改版时丢了
  if (act === 'md-edit') {
    const m = (mods || []).find((x) => x.id === id);
    if (!m) { toast('✗ 找不到这个模型'); return; }
    if (!provs.length) { toast('没有可用的服务商'); return; }
    modelDialog(provs, m);
    return;
  }
  if (act === 'md-del') {
    openDlg('删除模型', '<p style="font-size:13px;color:var(--ink2)">确定删除 <b class="mono">' + esc(id) + '</b>？</p>', '删除', async () => {
      const r = await send('/api/models/delete', { id }); toast(r.ok ? '✓ 已删除' : '✗ ' + (r.error || '失败'));
      await refresh(); render(); return true;
    });
    return;
  }
  // ⭐ 单个模型取元数据——旧版有，改版时丢了
  if (act === 'md-meta') {
    toast('取元数据中…');
    try {
      const r = await send('/api/models/fetch-meta', { modelId: id });
      const one = (r.results || [])[0] || {};
      toast(one.ok ? '✓ 已从 ' + (one.from || '服务商') + ' 取到' : '✗ ' + (one.error || '失败'));
    } catch (err) {
      toast('✗ ' + (err && err.message ? err.message : '失败'));
    }
    await refresh(); render();
    return;
  }
  if (act === 'md-test') {
    toast('测试中…'); const r = await send('/api/models/test', { modelId: id }); toast((r.ok ? '✓ ' : '✗ ') + (r.note || r.error || ''));
    return;
  }
}

PAGES['models'] = { render: renderModels };
