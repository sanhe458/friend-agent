/* 页面：personas（人格预设） */
async function renderPersonas(v) {
  const d = await api('/api/personas');
  if (v !== document.getElementById('view')) return;
  const list = d.personas || [];
  const def = d.defaultPersonaId || 'xiaoman';
  const ppl = (ST.state.persons || []);

  v.innerHTML =
    '<div class="card sec"><div class="row">' +
      '<div><b style="font-size:14px">人格预设</b>' +
      '<div class="hint" style="margin:4px 0 0">一套 prompt 就是一套人格。全局默认：<b class="mono">' + esc(def) + '</b>；某个人可以单独指定。</div></div>' +
      '<span class="spacer"></span><button class="btn pri" id="pe-add">+ 新建人格</button></div></div>' +
    '<div class="grid g2">' + list.map((p) => {
      const isDef = p.id === def;
      const users = ppl.filter((x) => x.personaId === p.id);
      return '<div class="card"><div class="row"><b style="font-size:15px">' + esc(p.name) + '</b>' +
        '<span class="mono" style="font-size:11px;color:var(--ink3)">' + esc(p.id) + '</span>' +
        '<span class="spacer"></span>' +
        (p.builtin ? '<span class="tag">内置</span>' : '') +
        (isDef ? '<span class="tag on">全局默认</span>' : '') + '</div>' +
        '<div style="font-size:12.5px;color:var(--ink2);margin:10px 0;white-space:pre-wrap;max-height:150px;overflow:auto;line-height:1.6">' + esc(p.prompt.slice(0, 420)) + (p.prompt.length > 420 ? '…' : '') + '</div>' +
        (users.length ? '<div class="hint" style="margin:0 0 10px">指定给了：' + esc(users.map((x) => x.displayName).join('、')) + '</div>' : '') +
        '<div class="row">' +
          (p.builtin ? '' : '<button class="btn sm" data-pe="edit" data-id="' + esc(p.id) + '">编辑</button>') +
          (isDef ? '' : '<button class="btn sm" data-pe="default" data-id="' + esc(p.id) + '">设为全局默认</button>') +
          (p.builtin ? '' : '<button class="btn sm danger" data-pe="del" data-id="' + esc(p.id) + '">删除</button>') +
        '</div></div>';
    }).join('') + '</div>' +
    '<div class="card"><h3>给某个人单独指定</h3>' +
      '<p class="hint">不指定就用全局默认。切换只影响这一个对话。</p>' +
      '<div class="grid g2">' + ppl.map((x) => {
        const cur = x.personaId || '';
        return '<div class="row" style="gap:8px;padding:8px 0;border-bottom:1px solid var(--line)">' +
          '<b style="min-width:110px">' + esc(x.displayName) + '</b>' +
          '<select data-pp="' + esc(x.id) + '" style="flex:1">' +
            '<option value=""' + (cur ? '' : ' selected') + '>（用全局默认）</option>' +
            list.map((p) => '<option value="' + esc(p.id) + '"' + (cur === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
          '</select></div>';
      }).join('') + '</div></div>';

  const peAdd = $('#pe-add');
  if (peAdd) peAdd.addEventListener('click', () => personaDlg(v, list, null));

  $$('[data-pe]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.getAttribute('data-pe'), id = b.getAttribute('data-id');
    if (act === 'edit') {
      const p = list.find((x) => x.id === id);
      personaDlg(v, list, p);
    } else if (act === 'default') {
      const r = await send('/api/personas/default', { id });
      toast(r.ok ? '✓ 已设为全局默认' : '✗ ' + (r.error || '失败'));
      renderPersonas(v);
    } else if (act === 'del') {
      openDlg('删除人格', '<p style="font-size:13px;color:var(--ink2)">确定删除「' + esc(id) + '」？用了它的人会回到全局默认。</p>', '删除', async () => {
        const r = await send('/api/personas/delete', { id });
        toast(r.ok ? '✓ 已删除' : '✗ ' + (r.error || '失败'));
        renderPersonas(v);
        return true;
      });
    }
  }));

  $$('[data-pp]').forEach((s) => s.addEventListener('change', async () => {
    const r = await send('/api/person/set-persona', { personId: s.getAttribute('data-pp'), personaId: s.value });
    toast(r.ok ? '✓ 已更新（下条消息生效）' : '✗ ' + (r.error || '失败'));
    if (r.ok) await refresh();
  }));
}

/** 新建 / 编辑人格的弹窗 */
function personaDlg(v, list, p) {
  const editing = Boolean(p);
  openDlg(editing ? '编辑人格' : '新建人格',
    '<label class="f"><span>名字（它会用这个名字自称）</span><input id="pe-name" value="' + esc(p?.name || '') + '" placeholder="小雨"></label>' +
    '<label class="f"><span>ID（唯一键' + (editing ? '，不可改' : '') + '）</span><input id="pe-id" value="' + esc(p?.id || '') + '"' + (editing ? ' readonly' : '') + ' placeholder="xiaoyu"></label>' +
    '<label class="f"><span>人格正文</span><textarea id="pe-prompt" rows="12" placeholder="你是……&#10;&#10;说话方式：&#10;- ……">' + esc(p?.prompt || '') + '</textarea></label>' +
    '<p class="hint" style="margin:-6px 0 8px">正文会被拼到 system prompt 最前面；建议写清「说话方式 / 做事方式 / 边界」。</p>', '保存', async () => {
    const r = await send('/api/personas', {
      id: $('#pe-id').value.trim(), name: $('#pe-name').value.trim(), prompt: $('#pe-prompt').value,
    });
    if (!r.ok) { toast('✗ ' + (r.error || '失败')); return false; }
    toast('✓ 已保存');
    await refresh();
    renderPersonas(v);
    return true;
  });
}

PAGES['personas'] = { render: renderPersonas };
