import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { ToolRegistry } from '../src/tools/registry.ts';
import { registerBrowserTool } from '../src/tools/browser.ts';

/**
 * 真浏览器工具验证。除了基础能力，**重点验证这轮修掉的几个坑**：
 *   ① 导航失败必须如实报错（以前 DNS 挂了也显示"已打开"）
 *   ② 同一会话的并发调用不能开出两个 Chromium
 *   ③ 关会话后不能留孤儿进程（Chromium 的 zygote/renderer 是独立子进程）
 */
const reg = new ToolRegistry();
registerBrowserTool(reg);
const ctx = { personId: 'verify-' + Date.now(), channel: 'panel', chatType: 'private' };
const call = (args: any) => reg.call('browse', args, ctx) as Promise<string>;

/** 数一下我们端口池里的 chromium 进程（9350..9389） */
const ourChromium = () => {
  try {
    const out = execSync("ps -eo cmd | grep '[c]hrome' || true", { encoding: 'utf8' });
    return out.split('\n').filter((l) => /--remote-debugging-port=93[5-8]\d/.test(l)).length;
  } catch { return -1; }
};

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><title>JS 测试页</title></head><body>
<h1 id="t">before</h1>
<script>document.getElementById('t').textContent = 'JS-RENDERED-OK';</script>
<a id="go" href="https://example.com/">去 example</a>
</body></html>`);

console.log('=== ① 导航失败必须如实报错（修前会说"已打开"）===');
const bad = await call({ action: 'open', url: 'https://this-domain-definitely-does-not-exist-9x7q.invalid' });
console.log(bad);
console.log('  → 判定:', /✗|失败/.test(bad) ? '✅ 如实报错' : '❌ 把失败当成功了');

console.log('\n=== ② 基础能力（JS 渲染 / snapshot / click / screenshot）===');
console.log(await call({ action: 'open', url: PAGE, waitMs: 1200 }));
const t1 = await call({ action: 'text' });
console.log('  text →', JSON.stringify(t1));
console.log('  → 判定:', t1.includes('JS-RENDERED-OK') ? '✅ JS 渲染' : '❌ 没渲染');
console.log('  snapshot →', (await call({ action: 'snapshot' })).split('\n')[0]);
console.log('  click →', (await call({ action: 'click', selector: '#go', waitMs: 2500 })).replace('\n', ' | '));
const url = await call({ action: 'url' });
console.log('  → 判定:', /example\.com/.test(url) ? '✅ 真跳转' : '❌ 没跳转');
const shot = await call({ action: 'screenshot' });
const p = String(shot).replace(/^已截图：/, '').trim();
console.log('  → 判定:', existsSync(p) && statSync(p).size > 1000 ? `✅ 截图 ${statSync(p).size} 字节` : '❌ 截图无效');

console.log('\n=== ③ 并发同一会话：不能开出两个 Chromium ===');
const before = ourChromium();
ctx.personId = 'race-' + Date.now();
await Promise.all([
  call({ action: 'open', url: PAGE, waitMs: 600 }),
  call({ action: 'text' }),
  call({ action: 'url' }),
]);
const after = ourChromium();
console.log(`  并发前 ${before} 个 → 并发后 ${after} 个（差 ${after - before}）`);
console.log('  → 判定:', after - before <= 8 ? '✅ 只起了一个实例（Chromium 单实例约 6-8 进程）' : '❌ 可能起了多个实例');

console.log('\n=== ④ close 之后不能留孤儿 ===');
const b4 = ourChromium();
await call({ action: 'close' });
await new Promise((r) => setTimeout(r, 1200));
const af = ourChromium();
console.log(`  关闭前 ${b4} 个 → 关闭后 ${af} 个`);
console.log('  → 判定:', af < b4 ? '✅ 进程被回收' : '⚠️ 仍有残留');

process.exit(0);
