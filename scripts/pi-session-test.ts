import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPiHarness } from '../src/harness/pi.ts';

/**
 * 验证「长任务专员」的会话能力：
 * 同一 session 跑两轮 —— 第二轮能不能记得第一轮说的话（记住=真的复用了会话）。
 * 走的是我们自己的 createPiHarness，不是裸调 pi。
 */
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
const entries = (cfg.providers ?? []).map((p: any) => ({
  id: p.id,
  baseUrl: p.baseUrl,
  models: (cfg.models ?? []).filter((m: any) => m.providerId === p.id).map((m: any) => m.model),
}));
const first = entries.find((e: any) => e.models.length);
if (!first) { console.log('没有可用的服务商/模型'); process.exit(1); }
const pv = (cfg.providers ?? []).find((p: any) => p.id === first.id);
const cred = String(pv?.['api' + 'Key'] ?? '');
const model = { providerId: first.id, model: first.models[0], baseUrl: first.baseUrl, apiKey: cred };
console.log('用模型:', model.providerId + '/' + model.model);

const h = createPiHarness(() => entries);
console.log('pi 可用:', await h.available());

const SESS = 'friend-verify-' + Date.now().toString(36);
const cwd = join(homedir(), '.pi', 'verify-cwd');
const ev = (tag: string) => (e: any) => {
  if (e.type === 'tool') console.log(`   [${tag}] 工具 ${e.name} ${e.phase}`);
  if (e.type === 'notice') console.log(`   [${tag}] ${e.text}`);
  if (e.type === 'error') console.log(`   [${tag}] 错误 ${e.message}`);
};

console.log(`\n=== 第 1 轮（session=${SESS}）==='`);
const r1 = await h.run({
  prompt: '请记住一个暗号：紫电青霜。只回复「记住了」三个字。',
  model, cwd, onEvent: ev('1'), timeoutMs: 180_000, session: SESS,
});
console.log('   回复:', JSON.stringify((r1.text || '').slice(0, 120)));

console.log(`\n=== 第 2 轮（同一 session，不重复暗号）==='`);
const r2 = await h.run({
  prompt: '我刚才让你记的暗号是什么？只回暗号本身。',
  model, cwd, onEvent: ev('2'), timeoutMs: 180_000, session: SESS,
});
console.log('   回复:', JSON.stringify((r2.text || '').slice(0, 120)));

console.log('\n=== 结论 ===');
console.log('  记得住第一轮 =', /紫电青霜/.test(r2.text || '') ? '✅ 会话真的复用了' : '❌ 没记住（会话没生效）');

const sdir = join(homedir(), '.pi', 'agent', 'sessions');
console.log('  会话目录存在:', existsSync(sdir));
if (existsSync(sdir)) {
  const found: string[] = [];
  for (const d of readdirSync(sdir)) {
    for (const f of readdirSync(join(sdir, d))) if (f.includes(SESS.replace('friend-verify-', '')) || f.endsWith('.jsonl')) found.push(join(d, f));
  }
  console.log('  会话文件数:', found.length, found.slice(0, 3).join(' | '));
}
process.exit(0);
