import { unlinkSync, existsSync } from 'node:fs';
import { createSqlitePersistence } from '../src/store/persist.ts';
import { IdentityService } from '../src/core/person.ts';

/**
 * 验证「身份合并能不能正确落盘」。
 * 这轮把 savePerson 从「只 upsert」改成「先删这个人的全部绑定再按内存重插」——
 * 以前移走的绑定会**留在库里指着旧人**，重启后 loadPersons 会把它加回来（合并部分回滚）。
 *
 * 测试流程：合并 → 关库 → 重开同一个库 → 看身份是否还是合并后的样子。
 */
const file = '/tmp/merge-persist-' + Date.now() + '.db';
const clean = () => { for (const s of ['', '-wal', '-shm']) { const p = file + s; if (existsSync(p)) unlinkSync(p); } };

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// ── 第一段：建档 + 合并 ──
const p1 = createSqlitePersistence(file);
const ids1 = new IdentityService(p1);
const a = ids1.resolve('qq', 'u1');
const b = ids1.resolve('telegram', 'u2');
console.log('建档：qq:u1 =', a.id, '｜ telegram:u2 =', b.id);

const { code } = ids1.requestMerge(
  { channel: 'telegram', externalId: 'u2' },
  { channel: 'qq', externalId: 'u1' },
);
const merged = ids1.confirmMerge(code, { channel: 'telegram', externalId: 'u2' });
check('合并后只剩一个身份', merged.bindings.length === 2, `bindings=${merged.bindings.map((x) => x.channel + ':' + x.externalId).join(',')}`);

// 库里现在应该只有 1 个人、2 条绑定
const rawPeople = p1.loadPersons();
check('库里只有 1 个人', rawPeople.length === 1, `实际 ${rawPeople.length}`);
check('库里有 2 条绑定', rawPeople[0]?.bindings.length === 2, `实际 ${rawPeople[0]?.bindings.length}`);
p1.close();

// ── 第二段：重开同一个库（模拟重启）──
console.log('\n重启（重开同一个库）…');
const p2 = createSqlitePersistence(file);
const ids2 = new IdentityService(p2);
const after = ids2.all();
check('重启后仍是 1 个人', after.length === 1, `实际 ${after.length}`);

const byTg = ids2.find('telegram', 'u2');
const byQQ = ids2.find('qq', 'u1');
check('telegram:u2 能找到', Boolean(byTg));
check('qq:u1 能找到', Boolean(byQQ));
check('两边指向同一个人', Boolean(byTg && byQQ && byTg.id === byQQ.id), `${byTg?.id} vs ${byQQ?.id}`);

// ── 第三段：修剪不会删掉最近的数据 ──
console.log('\n写 700 条历史 / 100 条事件，验证自动修剪…');
for (let i = 0; i < 700; i++) p2.saveHistory(a.id, { role: 'user', content: 'msg-' + i });
for (let i = 0; i < 100; i++) p2.saveEvent(a.id, { kind: 'x', at: Date.now(), i });
const h = p2.loadHistory(a.id, 5000);
check('历史被修剪到上限内', h.length <= 400, `实际 ${h.length}`);
check('保留的是最新的', h[h.length - 1]?.content === 'msg-699', `最后一条=${h[h.length - 1]?.content}`);
const e = p2.loadEvents(a.id, 5000);
check('事件被修剪到上限内', e.length <= 1200, `实际 ${e.length}`);
p2.close();
clean();

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
