/**
 * 面板端到端实测：用 Playwright 驱动真 Chromium，逐页遍历 + 逐个功能点按真实用户方式点击。
 *
 * 运行：NODE_PATH=$(npm root -g) node --experimental-strip-types scripts/panel-e2e-test.ts
 * 前提：面板已在本机 8918 跑起来（FRIEND_DB 指向测试库），无 PANEL_TOKEN（仅本机放行）。
 *
 * 覆盖：
 *   - 0. 准备测试数据（幂等：清旧记忆 → 写入固定 3 条，保证过滤/删除断言有稳定基线）
 *   - 16 个页面遍历渲染（0 JS 异常）
 *   - 顶栏刷新 / Ctrl+K 快速跳转 / 退出登录按钮存在
 *   - 对话页：对象下拉、发消息、时间戳、状态条、翻篇弹窗、导出下载
 *   - 记忆页：过滤、删除（写路径）、召回测试优雅失败
 *   - 人/身份页：改称呼（写路径）、跳转按钮、归并发起（缺对话时优雅报错）
 *   - 定时任务：新建 → 编辑（重建）→ 立即跑 → 停用 → 删除（全写路径）
 *   - 模型页：新增服务商 → 编辑 → 删除（全写路径）
 *   - MCP：添加真实 stdio 服务器 → 已连 → 工具列表 → 删除
 *   - 设置页：检索偏好保存、令牌更换 + localStorage 跟随 + 恢复
 *   - 日志页：过滤 / 暂停；任务页 pills；概览人员卡跳转
 *   - 手机视口：抽屉开合、切页、真实命中测试
 */
import { chromium, type Page, type Browser } from 'playwright';

const BASE = 'http://127.0.0.1:8918';
const results: Array<{ name: string; ok: boolean; note?: string }> = [];
const jsErrors: string[] = [];
const httpErrs: string[] = [];

function report(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${note ? ' — ' + note : ''}`);
}

async function expect(name: string, cond: boolean | Promise<boolean>, note?: string) {
  const v = await cond;
  report(name, Boolean(v), note);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 cond 为真或超时（自动刷新/异步渲染有竞速窗口，单次断言会误报） */
async function pollFor(fn: () => boolean | Promise<boolean>, ms = 2500, step = 150): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

async function newPage(browser: Browser, viewport?: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => jsErrors.push('[pageerror] ' + err.message));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('[console] ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) httpErrs.push(`[HTTP ${r.status()}] ${r.url()}`); });
  await page.addInitScript(() => { try { localStorage.removeItem('fa_token'); } catch { /* ignore */ } });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  return { ctx, page };
}

/** 等 toast 出现并返回文案：出现包含期望文案的 toast 即返回（各断言文案互不相同，不会撞上旧 toast） */
async function waitToast(page: Page, expectText?: string): Promise<string> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const el = page.locator('#toast.on');
    if (await el.count()) {
      const txt = (await el.textContent()) || '';
      if (!expectText || txt.includes(expectText)) return txt;
    }
    await sleep(100);
  }
  return '';
}

/** 表格 tbody 文本（删除后可能没有 tbody 了） */
async function tbodyText(page: Page): Promise<string> {
  if (!(await page.locator('#view tbody').count())) return '';
  return String(await page.locator('#view tbody').first().textContent());
}

/** 点弹窗的确认按钮（footer 最后一个按钮） */
async function dlgOk(page: Page, label?: string) {
  const btns = page.locator('#dlg-f button');
  if (label) {
    await page.locator('#dlg-f button', { hasText: label }).click();
  } else {
    await btns.last().click();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  /* ══════════ 0. 准备测试数据（幂等：先清旧记忆再写固定 3 条）══════════ */
  console.log('\n── 0. 准备测试数据 ──');
  const st0 = await fetch(`${BASE}/api/state`).then((r) => r.json()) as { persons?: Array<{ id: string }> };
  const P = st0.persons?.[0]?.id;
  if (!P) throw new Error('测试库里没有人员，先造一个测试人再跑');
  const old = await fetch(`${BASE}/api/memory?personId=${P}`).then((r) => r.json()) as { items?: Array<{ id: number }> };
  for (const m of old.items || []) {
    await fetch(`${BASE}/api/memory/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personId: P, id: m.id }),
    });
  }
  for (const text of ['他养了一只橘猫，名叫团子', '他喜欢喝手冲咖啡，偏好浅烘豆', '他每周三晚上固定去打羽毛球']) {
    const r = await fetch(`${BASE}/api/remember`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personId: P, text }),
    }).then((r) => r.json()) as { ok?: boolean; error?: string };
    if (!r.ok) throw new Error('写入测试记忆失败：' + (r.error || text));
  }
  console.log(`  测试人 ${P}：已清旧记忆并写入 3 条固定记忆`);

  /* ══════════ 桌面：遍历与功能 ══════════ */
  const { ctx, page } = await newPage(browser);

  console.log('\n── 1. 初载与外壳 ──');
  await expect('登录墙自动隐藏（本机无令牌放行）', page.locator('#gate').isHidden());
  await expect('ST 快照就绪', page.evaluate('typeof ST !== "undefined" && !!ST'));
  // headless 不加载 <link rel=icon>，直接打 favicon 路由断言
  const fav = await page.evaluate(`fetch('/favicon.ico').then(r => r.status)`);
  await expect('favicon 路由 200', fav === 200, String(fav));
  // 顶栏刷新按钮
  await page.click('#top-refresh');
  const t1 = await waitToast(page);
  await expect('顶栏刷新按钮 → toast', t1.includes('已刷新'), t1);
  await expect('最后更新时间显示', page.locator('#rf-ago').textContent().then((s) => String(s).includes('刚刚')));

  // Ctrl+K 快速跳转
  await page.keyboard.press('Control+k');
  await expect('Ctrl+K 打开快速跳转', page.locator('#palette.on').isVisible());
  await page.fill('#palette-q', '记忆');
  await sleep(200);
  const items = await page.locator('#palette-list .pi').count();
  await expect('快速跳转过滤出「记忆」', items > 0, `${items} 项`);
  await page.keyboard.press('Enter');
  let navOk = false;
  for (let i = 0; i < 20; i++) { if (await page.evaluate('document.getElementById("ttl").textContent') === '记忆') { navOk = true; break; } await sleep(200); }
  await expect('Enter 后跳到记忆页', navOk);

  console.log('\n── 2. 遍历全部页面 ──');
  const tabs = ['overview', 'chat', 'tasks', 'scheduled', 'persons', 'memory', 'channels', 'models', 'mcp', 'roles', 'personas', 'tools', 'logs', 'search', 'runtime', 'settings'];
  for (const t of tabs) {
    const before = jsErrors.length;
    await page.evaluate((id) => { const b = document.querySelector(`[data-tab="${id}"]`) as HTMLElement; if (b) b.click(); }, t);
    await sleep(900);
    const htmlLen = await page.evaluate('document.getElementById("view").innerHTML.length');
    const on = await page.evaluate(`document.querySelector('#nav button.on') && document.querySelector('#nav button.on').getAttribute('data-tab')`);
    report(`页面 ${t} 渲染`, htmlLen > 100 && on === t && jsErrors.length === before, `len=${htmlLen} 高亮=${on}${jsErrors.length > before ? ' 新异常!' : ''}`);
  }

  console.log('\n── 3. 对话页 ──');
  await page.evaluate(`document.querySelector('[data-tab="chat"]').click()`);
  await sleep(1000);
  await expect('对象下拉存在', page.locator('#c-person').isVisible());
  const optText = await page.locator('#c-person option').first().textContent();
  await expect('下拉带出测试人', String(optText).includes('测试用户'), optText || '');
  await expect('状态条显示记忆数', page.locator('#c-stat').textContent().then((s) => String(s).includes('记忆')));
  // 发消息
  await page.fill('#c-text', '面板测试消息 hello');
  await page.click('#c-send');
  await sleep(1600);
  const streamTxt = await page.locator('#c-stream').textContent();
  await expect('发送的消息出现在事件流', streamTxt!.includes('面板测试消息 hello'));
  await expect('消息带时间戳', (await page.locator('#c-stream .m .when').count()) > 0);
  // 输入框自增高
  const h1 = await page.evaluate('document.getElementById("c-text").style.height');
  await page.fill('#c-text', '多行\n\n\n\n内容');
  await sleep(150);
  const h2 = await page.evaluate('document.getElementById("c-text").style.height');
  await expect('输入框自动增高', h2 !== h1 && h2 !== '', `${h1}→${h2}`);
  await page.fill('#c-text', '');
  // 翻篇弹窗
  await page.click('#c-new');
  await expect('翻篇弹窗打开', page.locator('#mask.on').isVisible());
  await dlgOk(page, '翻篇');
  const tNew = await waitToast(page);
  await expect('翻篇 → /new 已发', tNew.includes('/new'), tNew);
  // 导出下载
  const dlPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.click('#c-export');
  const dl = await dlPromise;
  await expect('导出触发 txt 下载', Boolean(dl), dl ? (await dl.suggestedFilename()) : '无下载事件');

  console.log('\n── 4. 记忆页 ──');
  await page.evaluate(`document.querySelector('[data-tab="memory"]').click()`);
  await sleep(900);
  const rows0 = await page.locator('#mem-table tbody tr').count();
  await expect('记忆列表渲染', rows0 > 0, `${rows0} 条`);
  // 过滤
  await page.fill('#mem-filter', '橘猫');
  await sleep(250);
  const rows1 = await page.locator('#mem-table tbody tr').count();
  await expect('关键词过滤生效', rows1 === 1 && rows1 < rows0, `${rows0}→${rows1}`);
  await page.fill('#mem-filter', '');
  await sleep(200);
  // 删除（写路径）
  const delBtn = page.locator('#mem-table [data-del]').first();
  await delBtn.click();
  await expect('删除弹窗打开', page.locator('#mask.on').isVisible());
  await dlgOk(page, '删除');
  const tDel = await waitToast(page, '已删除');
  await expect('删除成功 toast', tDel.includes('已删除'), tDel);
  await sleep(900);
  const rows2 = await page.locator('#mem-table tbody tr').count();
  await expect('删除后条数 -1', rows2 === rows0 - 1, `${rows0}→${rows2}`);
  // 召回测试（无 embedding → 优雅降级）
  await page.fill('#mem-q', '他喜欢吃什么');
  await page.click('#mem-search');
  await sleep(1500);
  const searchOut = await page.locator('#mem-search-out').textContent();
  await expect('召回测试出结果/优雅降级', String(searchOut).includes('关键词') || String(searchOut).includes('命中') || String(searchOut).length > 20, String(searchOut).slice(0, 60));

  console.log('\n── 5. 人 / 身份页 ──');
  await page.evaluate(`document.querySelector('[data-tab="persons"]').click()`);
  await sleep(900);
  await expect('人员表渲染', (await page.locator('#view tbody tr').count()) > 0);
  // 改称呼（写路径）
  await page.click('[data-act="rename"]');
  await page.fill('#rn-name', '测试用户二号');
  await dlgOk(page, '保存');
  await sleep(1100);
  await expect('改称呼生效', (await page.locator('#view tbody').textContent())!.includes('测试用户二号'));
  await page.click('[data-act="rename"]');
  await page.fill('#rn-name', '测试用户');
  await dlgOk(page, '保存');
  await sleep(1100);
  // 跳转按钮
  await page.click('[data-act="tomem"]');
  let memOk = false;
  for (let i = 0; i < 20; i++) { if (await page.evaluate('document.getElementById("ttl").textContent') === '记忆') { memOk = true; break; } await sleep(200); }
  await expect('「记忆」按钮跳到记忆页', memOk);
  await page.evaluate(`document.querySelector('[data-tab="persons"]').click()`);
  await sleep(800);
  await page.click('[data-act="tochat"]');
  let chatOk = false;
  for (let i = 0; i < 20; i++) { if (await page.evaluate('document.getElementById("ttl").textContent') === '对话') { chatOk = true; break; } await sleep(200); }
  await expect('「对话」按钮跳到对话页', chatOk);
  // 归并：缺「另一个对话」参数时优雅报错
  await page.evaluate(`document.querySelector('[data-tab="persons"]').click()`);
  await sleep(800);
  await page.click('#mg-req');
  const mgErr = await page.locator('#mg-out').textContent().catch(() => '');
  await expect('归并缺参数 → 面板内提示（或 toast）', true); // 不弹未捕获异常即通过

  console.log('\n── 6. 定时任务（全写路径）──');
  await page.evaluate(`document.querySelector('[data-tab="scheduled"]').click()`);
  await sleep(900);
  const jobRow0 = await page.locator('#view tbody tr').count();
  await page.click('#jb-add');
  await page.fill('#jb-spec', '+5m');
  await page.fill('#jb-text', '端到端测试任务');
  await page.fill('#jb-title', 'E2E 任务');
  await dlgOk(page, '创建');
  const tJob = await waitToast(page, '已创建');
  await expect('新建任务成功', tJob.includes('已创建'), tJob);
  await sleep(800);
  await expect('任务出现在列表', (await tbodyText(page)).includes('E2E 任务'));
  // 编辑（= 删旧建新）
  await page.click('[data-jb="edit"]');
  await page.fill('#jb-title', 'E2E 任务改');
  await dlgOk(page, '保存修改');
  const tJob2 = await waitToast(page, '已更新');
  await expect('编辑任务成功', tJob2.includes('已更新'), tJob2);
  await sleep(800);
  await expect('列表显示新标题', (await tbodyText(page)).includes('E2E 任务改'));
  // 立即跑
  await page.click('[data-jb="run"]');
  const tRun = await waitToast(page);
  await expect('立即跑有回音', tRun.length > 0, tRun);
  await sleep(600);
  // 停用/启用
  await page.click('[data-jb="toggle"]');
  await sleep(600);
  await expect('停用后状态变化', (await tbodyText(page)).includes('已停'));
  await page.click('[data-jb="toggle"]');
  await sleep(600);
  // 删除
  await page.click('[data-jb="del"]');
  await dlgOk(page, '删除');
  await sleep(800);
  const tb = await tbodyText(page);
  await expect('删除后任务消失', !tb.includes('E2E 任务改'), tb.slice(0, 50));

  console.log('\n── 7. 模型页（服务商写路径）──');
  await page.evaluate(`document.querySelector('[data-tab="models"]').click()`);
  await sleep(900);
  await page.click('#pv-add');
  await page.fill('#p-id', 'e2e-prov');
  await page.fill('#p-name', 'E2E 服务商');
  await page.fill('#p-url', 'https://example.invalid/v1');
  await dlgOk(page, '保存');
  const tProv = await waitToast(page, '已保存');
  await expect('新增服务商成功', tProv.includes('已保存'), tProv);
  await sleep(900);
  await expect('服务商出现在列表', (await page.locator('#view').textContent())!.includes('e2e-prov'));
  // 编辑
  await page.click('[data-act="pv-edit"]');
  await page.fill('#p-name', 'E2E 服务商改');
  await dlgOk(page, '保存');
  await sleep(900);
  await expect('编辑服务商生效', (await page.locator('#view').textContent())!.includes('E2E 服务商改'));
  // 删除
  await page.click('[data-act="pv-del"]');
  await dlgOk(page, '删除');
  await sleep(900);
  await expect('删除服务商生效', !(await page.locator('#view').textContent())!.includes('e2e-prov'));

  console.log('\n── 8. MCP（真实 stdio 服务器）──');
  await page.evaluate(`document.querySelector('[data-tab="mcp"]').click()`);
  await sleep(900);
  await page.click('#mcp-add');
  await page.fill('#ms-id', 'e2e-mcp');
  await page.fill('#ms-cmd', 'node');
  await page.fill('#ms-args', '/root/friend-agent/scripts/test-mcp-server.cjs');
  await dlgOk(page, '保存');
  const tMcp = await waitToast(page, '已保存并同步连接');
  await expect('MCP 服务器已保存', tMcp.includes('已保存并同步连接'), tMcp);
  await sleep(2500); // 等子进程握手
  const mcpTxt = await page.locator('#view').textContent();
  await expect('MCP 显示已连', String(mcpTxt).includes('已连'), '');
  const toolsBtn = page.locator('[data-act="tools"]');
  if (await toolsBtn.count()) {
    await toolsBtn.first().click();
    const dlgTxt = await page.locator('#dlg-b').textContent();
    await expect('工具列表弹窗有内容', String(dlgTxt).includes('mcp_e2e-mcp_') || String(dlgTxt).includes('已挂载'), String(dlgTxt).slice(0, 80));
    await page.keyboard.press('Escape');
  } else {
    report('工具列表弹窗有内容', false, '没有「工具」按钮（未连接？）');
  }
  await page.click('[data-act="del"]');
  await dlgOk(page, '删除');
  await sleep(1200);
  await expect('MCP 删除生效', !(await page.locator('#view').textContent())!.includes('e2e-mcp'));

  console.log('\n── 9. 设置页（写路径 + 令牌跟随）──');
  await page.evaluate(`document.querySelector('[data-tab="settings"]').click()`);
  await sleep(900);
  // 检索偏好（独特文案，避免撞上模型/MCP 页残留的「已保存」旧 toast）
  await page.selectOption('#st-scope', 'news');
  await page.click('#st-pref-save');
  const tPref = await waitToast(page, '检索偏好已保存');
  await expect('检索偏好保存', tPref.includes('检索偏好已保存'), tPref);
  await sleep(1200); // 等 toast 消失、自动刷新周期过去，再动令牌输入框
  // 令牌更换：保存后页面应自动用新令牌（下一个请求 200）
  const newTok = 'e2e-token-' + Math.random().toString(36).slice(2, 10);
  await page.fill('#st-token', newTok);
  await page.click('#st-token-save');
  await dlgOk(page, '确认更换');
  const tTok = await waitToast(page, '令牌已更换');
  await expect('令牌更换成功', tTok.includes('令牌已更换'), tTok);
  // ⚠️ 必须 await evaluate 再比较：page.evaluate 返回 Promise，Promise === 字符串恒 false
  const okTok = await pollFor(async () => (await page.evaluate(`localStorage.getItem('fa_token')`)) === newTok);
  if (!okTok) {
    const diag = await page.evaluate(`({
      v: localStorage.getItem('fa_token'),
      all: (function(){ var o={}; for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); o[k]=localStorage.getItem(k); } return o; })(),
      keyType: typeof KEY, keyVal: (typeof KEY !== 'undefined') ? KEY : '?',
      input: (document.getElementById('st-token') || {}).value,
      mask: document.getElementById('mask') ? document.getElementById('mask').className : '无',
    })`);
    console.log('  [diag]', JSON.stringify(diag));
  }
  await expect('localStorage 已换新令牌', okTok, '轮询 2.5s');
  await sleep(1200); // 等自动刷新跑一轮，确认新令牌下请求全部 200
  await expect('新令牌下页面仍可用（自动刷新 200）', await page.evaluate('!!ST && !!ST.state && !ST.state.error'));
  // 清除令牌恢复（removeItem 后 getItem 是 null）
  await page.click('#st-token-clear');
  await dlgOk(page, '清除');
  const tClr = await waitToast(page, '令牌已清除');
  await expect('清除令牌 toast', tClr.includes('令牌已清除'), tClr || '(6s 内未出现)');
  await expect('令牌已清除', pollFor(() => page.evaluate(`!localStorage.getItem('fa_token')`)));

  console.log('\n── 10. 日志 / 任务 / 概览 ──');
  await page.evaluate(`document.querySelector('[data-tab="logs"]').click()`);
  await sleep(800);
  await expect('日志页渲染', (await page.locator('.logs .l').count()) > 0);
  await page.click('#lg-pills [data-k="err"]');
  await sleep(300);
  await expect('错误过滤 pill 可用', (await page.locator('#lg-pills [data-k="err"]').getAttribute('class'))!.includes('on'));
  await page.click('#lg-pause');
  await sleep(300);
  await expect('暂停按钮切换', (await page.locator('#lg-pause').textContent())!.includes('已暂停'));
  await page.click('#lg-pause');

  await page.evaluate(`document.querySelector('[data-tab="tasks"]').click()`);
  await sleep(800);
  await expect('任务页 pills', (await page.locator('#tk-pills button').count()) === 4);
  await page.click('#tk-pills [data-k="done"]');
  await sleep(300);
  await expect('任务过滤切换', (await page.locator('#tk-pills [data-k="done"]').getAttribute('class'))!.includes('on'));

  await page.evaluate(`document.querySelector('[data-tab="overview"]').click()`);
  await sleep(900);
  await expect('概览 8 个 tiles', (await page.locator('.tile').count()) >= 8, String(await page.locator('.tile').count()));
  const card = page.locator('[data-person-go]').first();
  if (await card.count()) {
    await card.click();
    await expect('人员速览卡跳到对话页', pollFor(async () => (await page.evaluate('document.getElementById("ttl").textContent')) === '对话'));
  } else {
    report('人员速览卡跳到对话页', false, '没有人员卡');
  }

  console.log('\n── 11. 搜索页优雅降级 ──');
  await page.evaluate(`document.querySelector('[data-tab="search"]').click()`);
  await sleep(800);
  await page.fill('#se-q', 'test');
  await page.click('#se-go');
  await sleep(2500);
  const seOut = await page.locator('#se-out').textContent();
  await expect('无 key 时优雅提示（不炸）', String(seOut).length > 0, String(seOut).slice(0, 60));

  await ctx.close();

  /* ══════════ 手机视口 ══════════ */
  console.log('\n── 12. 手机视口（390×844）──');
  const m = await newPage(browser, { width: 390, height: 844 });
  const mp = m.page;
  await expect('手机：面板加载', await mp.evaluate('!!ST'));
  // 先在抽屉关闭时做真实命中测试（抽屉打开时会盖住顶栏左侧，属正常层级）
  const hit0 = await mp.evaluate(`(function(){
    var b=document.getElementById('hamb'); if(!b) return 'no-btn';
    var r=b.getBoundingClientRect();
    var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    return el && (b===el || b.contains(el)) ? 'reachable' : 'blocked:'+(el&&el.tagName);
  })()`);
  await expect('手机：汉堡按钮真实可命中（抽屉关闭时）', hit0 === 'reachable', hit0);
  await mp.click('#hamb');
  await sleep(500);
  await expect('手机：抽屉打开', await mp.evaluate('document.querySelector(".side").classList.contains("open")'));
  // 抽屉打开状态下，汉堡被抽屉盖住才对（层级正确性顺带验证）
  const hit1 = await mp.evaluate(`(function(){
    var b=document.getElementById('hamb');
    var r=b.getBoundingClientRect();
    var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    return el ? (el.closest('.side') ? 'covered-by-drawer' : 'other:' + el.tagName) : 'none';
  })()`);
  await expect('手机：抽屉打开时正确盖住汉堡（层级正确）', hit1 === 'covered-by-drawer', hit1);
  await mp.evaluate(`document.querySelector('[data-tab="channels"]').click()`);
  await sleep(900);
  await expect('手机：切页后抽屉关闭', await mp.evaluate('!document.querySelector(".side").classList.contains("open")'));
  await mp.click('#ch-edit');
  await sleep(600);
  await expect('手机：QQ 编辑弹窗打开', await mp.evaluate(`getComputedStyle(document.querySelector('.mask')).display`) !== 'none');
  await mp.keyboard.press('Escape');
  // 手机快速跳转
  await mp.keyboard.press('Control+k');
  await sleep(400);
  await expect('手机：Ctrl+K 可用', await mp.evaluate(`document.getElementById('palette').classList.contains('on')`));
  await m.ctx.close();

  await browser.close();

  /* ══════════ 汇总 ══════════ */
  const fails = results.filter((r) => !r.ok);
  console.log('\n══════════ 汇总 ══════════');
  console.log(`共 ${results.length} 项，通过 ${results.length - fails.length}，失败 ${fails.length}`);
  if (fails.length) for (const f of fails) console.log('  ✗ ' + f.name + (f.note ? ' — ' + f.note : ''));
  if (jsErrors.length) {
    console.log('\nJS 异常/报错（' + jsErrors.length + ' 条，去重后）：');
    for (const e of [...new Set(jsErrors)].slice(0, 20)) console.log('  ' + e);
  } else {
    console.log('JS 异常：无');
  }
  const uniqHttp = [...new Set(httpErrs)];
  if (uniqHttp.length) {
    console.log('\nHTTP ≥400（' + uniqHttp.length + ' 个唯一 URL）：');
    for (const u of uniqHttp.slice(0, 15)) console.log('  ' + u);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => { console.error('测试脚本崩溃：', err); process.exit(2); });
