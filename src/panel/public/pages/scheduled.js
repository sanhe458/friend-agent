/* 页面：定时任务 */
const SPEC_HINT = '可用：+30m（30 分钟后一次）｜every:2h（每 2 小时）｜daily:08:00（每天 8 点）｜0 8 * * *（cron）';

async function renderScheduled(v) {
  const d = await api('/api/jobs');
  if (v !== document.getElementById('view')) return; // 已经切走就别覆盖
  const jobs = (d.jobs || []).slice().sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0));
  const now = d.now || Date.now();
  const fmt = (t) => {
    if (!t || t > 8e15) return '—';
    const dt = new Date(t);
    const diff = Math.round((t - now) / 1000);
    const left = diff >= 0
      ? (diff < 60 ? diff + 's 后' : diff < 3600 ? Math.round(diff / 60) + 'm 后' : Math.round(diff / 3600) + 'h 后')
      : '已过期';
    return dt.toLocaleString('zh-CN', { hour12: false }).slice(5) + '（' + left + '）';
  };
  v.innerHTML =
    '<div class="card sec"><div class="row">' +
      '<div><b style="font-size:14px">定时任务</b>' +
      '<div class="hint" style="margin:4px 0 0">到点会主动找他说话。agent 自己也能建（工具 <span class="mono">schedule_task</span>）。</div></div>' +
      '<span class="spacer"></span>' +
      '<span class="tag">' + jobs.filter((j) => j.enabled).length + ' 个启用中</span>' +
      '<button class="btn pri" id="jb-add">+ 新建定时任务</button></div></div>' +
    '<div class="card pad0">' + (jobs.length
      ? '<table class="acts"><thead><tr><th>标题</th><th>规则</th><th>下次</th><th>类型</th><th>状态</th><th class="num">已跑</th><th>最近结果</th><th></th></tr></thead><tbody>' +
        jobs.map((j) => '<tr><td><b>' + esc(j.title) + '</b><div class="mono" style="font-size:11px;color:var(--ink3)">' + esc(j.id) + '</div></td>' +
          '<td class="mono" style="font-size:12px">' + esc(j.spec) + '</td>' +
          '<td class="num" style="font-size:12px">' + fmt(j.nextAt) + '</td>' +
          '<td>' + (j.kind === 'ask' ? '<span class="tag info">触发思考</span>' : '<span class="tag">直接发话</span>') + '</td>' +
          '<td>' + (j.enabled ? '<span class="tag on">启用</span>' : '<span class="tag off">已停</span>') + '</td>' +
          '<td class="num">' + (j.runs || 0) + '</td>' +
          '<td style="font-size:12px;color:var(--ink2)">' + esc(String(j.lastResult || '—').slice(0, 40)) + '</td>' +
          '<td class="row"><button class="btn sm" data-jb="run" data-id="' + esc(j.id) + '">立即跑</button>' +
          '<button class="btn sm" data-jb="toggle" data-id="' + esc(j.id) + '" data-on="' + (j.enabled ? '0' : '1') + '">' + (j.enabled ? '停用' : '启用') + '</button>' +
          '<button class="btn sm danger" data-jb="del" data-id="' + esc(j.id) + '">删除</button></td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">还没有定时任务。点右上角新建，或直接让 agent 自己排（比如「明天早上 8 点提醒我」）。</div>') + '</div>';

  $('#jb-add').addEventListener('click', () => {
    openDlg('新建定时任务',
      '<label class="f"><span>给谁</span><select id="jb-who">' +
        (ST.state.persons || []).flatMap((p) => (p.bindings || []).map((b) =>
          '<option value="' + esc(p.id + '|' + b.channel + '|' + b.externalId) + '">' + esc(p.id + ' ← ' + b.channel + ':' + String(b.externalId).slice(0, 16)) + '</option>')).join('') +
      '</select></label>' +
      '<label class="f"><span>时间规则</span><input id="jb-spec" placeholder="+30m / every:2h / daily:08:00 / 0 8 * * *"></label>' +
      '<p class="hint" style="-6px 0 12px">' + esc(SPEC_HINT) + '</p>' +
      '<label class="f"><span>类型</span><select id="jb-kind">' +
        '<option value="say">say · 到点把下面这句话原样发出去</option>' +
        '<option value="ask">ask · 到点触发一轮思考，让它自己组织语言</option>' +
      '</select></label>' +
      '<label class="f"><span>内容</span><textarea id="jb-text" rows="3" placeholder="say=要发的话；ask=给自己的提示词"></textarea></label>' +
      '<label class="f"><span>标题（可选）</span><input id="jb-title" placeholder="留空则截取内容"></label>', '创建', async () => {
      const who = ($('#jb-who').value || '').split('|');
      if (who.length < 3) { toast('✗ 没有可选的对象'); return false; }
      const r = await send('/api/jobs', {
        personId: who[0], channel: who[1], to: who[2],
        spec: $('#jb-spec').value.trim(),
        kind: $('#jb-kind').value,
        text: $('#jb-text').value,
        title: $('#jb-title').value.trim(),
      });
      toast(r.ok ? '✓ 已创建（下次 ' + new Date(r.job.nextAt).toLocaleString('zh-CN', { hour12: false }) + '）' : '✗ ' + (r.error || '失败'));
      if (r.ok) renderScheduled(v);
      return r.ok;
    });
  });

  $$('[data-jb]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.getAttribute('data-jb'), id = b.getAttribute('data-id');
    if (act === 'run') {
      toast('执行中…');
      const r = await send('/api/jobs/run', { id });
      toast((r.ok ? '✓ ' : '✗ ') + (r.result || r.error || ''));
      renderScheduled(v);
    } else if (act === 'toggle') {
      const r = await send('/api/jobs/toggle', { id, enabled: b.getAttribute('data-on') === '1' });
      toast(r.ok ? '✓ 已更新' : '✗ ' + (r.error || '失败'));
      renderScheduled(v);
    } else if (act === 'del') {
      openDlg('删除定时任务', '<p style="font-size:13px;color:var(--ink2)">确定删除 <b class="mono">' + esc(id) + '</b>？</p>', '删除', async () => {
        const r = await send('/api/jobs/delete', { id });
        toast(r.ok ? '✓ 已删除' : '✗ 没找到');
        renderScheduled(v);
        return true;
      });
    }
  }));
}

PAGES['scheduled'] = { render: renderScheduled };
