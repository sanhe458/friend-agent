/**
 * 记忆语义召回端到端测试（真实打嵌入/重排 API）。
 *
 * 用法：
 *   SF_API_KEY=sk-xxx node scripts/memory-vec-test.ts
 *
 * 不设 SF_API_KEY 时也可以跑「降级模式」：验证没配嵌入模型时一切照旧（纯关键词）。
 *
 * 验证点：
 *   ① 写入记忆 → 后台自动补算向量并落库
 *   ② 语义召回：换一种说法也能命中（关键词做不到）
 *   ③ rerank 精排生效（probe 的 source=rerank）
 *   ④ 降级链：嵌入配错/失败时 recall 不炸，自动退回关键词
 *   ⑤ 持久化：重开 store 后向量从库里恢复，无需重算即可召回
 */
import { rmSync } from 'node:fs';
import { createSqlitePersistence } from '../src/store/persist.ts';
import { MemoryStore, type MemoryModelDeps } from '../src/memory/store.ts';
import { embed } from '../src/models/embedding.ts';
import { rerank } from '../src/models/rerank.ts';
import type { ModelDef, Provider } from '../src/config.ts';

const SF = 'https://api.siliconflow.cn/v1';
const KEY = process.env.SF_API_KEY ?? '';
const EMB_MODEL = process.env.SF_EMBED_MODEL ?? 'BAAI/bge-m3';
const RR_MODEL = process.env.SF_RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3';
const DB = '/tmp/friend-memory-vec-test.db';

let failed = 0;
const ok = (cond: boolean, name: string, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' ｜ ' + extra : ''}`);
  if (!cond) failed++;
};

/** 模拟注册表解析出的模型配置（MemoryModelDeps 形状，和 app.ts 里的接法一致） */
function depsWith(model: string, key: string, withRerank = true): MemoryModelDeps {
  const eCfg = { baseUrl: SF, apiKey: key, model };
  const rCfg = { baseUrl: SF, apiKey: key, model: RR_MODEL };
  return {
    embedding: () => (model ? eCfg : undefined),
    rerank: () => (withRerank && key ? rCfg : undefined),
  };
}

/** 等这个 store 里所有记忆的向量都算好（写入是后台补算的） */
async function waitVecs(store: MemoryStore, pid: string, ms = 60_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const got = store.all(pid).filter((x) => (x as MemoryItem).vecModel).length;
    if (got >= store.all(pid).length) return Date.now() - t0;
    if (Date.now() - t0 > ms) return -1;
    await new Promise((r) => setTimeout(r, 300));
  }
}

interface MemoryItemLike { vec?: Float32Array; vecModel?: string }
type MemoryItem = Parameters<MemoryStore['write']>[1];

async function main(): Promise<void> {
  rmSync(DB, { force: true });

  // ── 前置：直接探一次嵌入与重排（脚本自身的先决条件）──────────
  if (KEY) {
    const e = await embed({ baseUrl: SF, apiKey: KEY, model: EMB_MODEL, input: ['连通性'] });
    console.log(`[pre] 嵌入连通：${e.dims} 维 / ${e.ms}ms`);
    const r = await rerank({ baseUrl: SF, apiKey: KEY, model: RR_MODEL, query: '喜欢什么', documents: ['苹果', '上海'] });
    console.log(`[pre] 重排连通：${r.length} 条结果`);
  } else {
    console.log('[pre] 未设 SF_API_KEY → 只跑降级模式（关键词召回回归）');
  }

  // ── ① 写入 + 后台向量化 ─────────────────────────────
  const persist = createSqlitePersistence(DB);
  const store = new MemoryStore(persist, KEY ? depsWith(EMB_MODEL, KEY) : {});
  const pid = 'person-test';
  const facts = [
    '他最喜欢吃的水果是苹果，尤其是脆的',
    '他住在上海，浦东新区',
    '他养了一只橘猫，叫团子',
    '他是后端程序员，写 Go 和 Python',
    '他每周六早上会去爬山',
    '他对芒果过敏，吃了会起疹子',
    '他不喜欢香菜的味道',
    '他的生日在九月初',
  ];
  for (const f of facts) {
    store.write(pid, { text: f, tags: ['fact'], channel: 'qq', at: Date.now(), hot: true });
  }
  console.log(`\n[1] 写入 ${facts.length} 条记忆`);

  if (KEY) {
    const waitMs = await waitVecs(store, pid);
    const veced = (store.all(pid) as Array<MemoryItem & MemoryItemLike>).filter((x) => x.vecModel === EMB_MODEL).length;
    ok(waitMs >= 0, '后台向量全部就绪', `${veced}/${facts.length} 条，耗时 ${waitMs}ms`);
    // all() 按 design 剥掉 vec（面板序列化安全），所以这里只能看 vecModel
    ok(veced === facts.length, '每条记忆都带上了模型标记（向量已算好）', `标记=${EMB_MODEL}`);
  }

  // ── ② 语义召回（换说法命中）＋ 与关键词召回对比 ──────────
  const queries: Array<[string, string]> = [
    ['他爱吃水果吗', '苹果'],
    ['他生活在哪个城市', '上海'],
    ['家里有养什么动物', '橘猫'],
    ['有什么不能吃的东西', '芒果'],
    ['周末一般做什么运动', '爬山'],
  ];
  if (KEY) {
    console.log('\n[2] 语义召回（查询换了说法，字面关键词大多对不上）');
    for (const [q, expectSub] of queries) {
      const hits = await store.recall(pid, q, 3);
      const top = hits[0]?.text ?? '（无）';
      ok(hits.some((h) => h.text.includes(expectSub)), `「${q}」→ 命中「${expectSub}」`, `top1: ${top.slice(0, 22)}`);

      const kw = await (async () => {
        // 纯关键词参照：把嵌入撤掉再 recall
        const kwOnly = new MemoryStore(undefined, {});
        for (const f of facts) kwOnly.write(pid, { text: f, tags: ['fact'], channel: 'qq', at: Date.now(), hot: true });
        return kwOnly.recall(pid, q, 3);
      })();
      const kwHit = kw.some((h) => h.text.includes(expectSub));
      console.log(`      ↳ 纯关键词参照：${kwHit ? '也能命中' : '命中不了'}${kwHit ? '' : '（这就是升级的意义）'}`);
    }

    // ── ③ rerank 精排生效 ─────────────────────────────
    console.log('\n[3] probe：确认精排来源与分数');
    const probe = await store.probe(pid, '他的宠物叫什么名字', 5);
    ok(probe.length > 0 && probe[0].source === 'rerank', 'probe 首条 source=rerank', `source=${probe[0]?.source} score=${probe[0]?.score?.toFixed(3)}`);
    ok(probe.some((x) => x.text.includes('团子')), '「他的宠物叫什么名字」→ 命中橘猫团子');
  }

  // ── ④ 降级链：嵌入 key 是错的也绝不能炸 ────────────────
  console.log('\n[4] 降级：嵌入不可用 → 自动退回关键词，不抛错');
  const badStore = new MemoryStore(undefined, depsWith(EMB_MODEL, 'sk-invalid-key-for-degrade-test'));
  for (const f of facts) badStore.write(pid, { text: f, tags: ['fact'], channel: 'qq', at: Date.now(), hot: true });
  const degraded = await badStore.recall(pid, '苹果', 3);
  ok(degraded.some((h) => h.text.includes('苹果')), '坏 key 下 recall 正常返回（关键词兜底）', `hits=${degraded.length}`);
  // 给点时间让后台向量任务失败掉（会被 catch 吞掉，不能有未处理 rejection）
  await new Promise((r) => setTimeout(r, 1500));

  // ── ⑤ 持久化：重开 store，向量从库里恢复 ───────────────
  if (KEY) {
    console.log('\n[5] 持久化：关库重开，向量从 SQLite 恢复（不再重算也能召回）');
    const t0 = Date.now();
    const store2 = new MemoryStore(persist, depsWith(EMB_MODEL, KEY));
    const veced = (store2.all(pid) as Array<MemoryItem & MemoryItemLike>).filter((x) => x.vecModel === EMB_MODEL).length;
    ok(veced === facts.length, `重开即有 ${veced}/${facts.length} 条向量（从库恢复）`, `加载耗时 ${Date.now() - t0}ms`);
    // ⚠️ vecModel 是文本列恢复不了 BLOB 的坑（node:sqlite 返回 Uint8Array 不是 Buffer，实测踩过）：
    //    直接看底层 loadMemories 出来的向量维度，必须是 1024 而不是 0
    const rows = persist.loadMemories().filter((r) => r.personId === pid);
    const dimOk = rows.length > 0 && rows.every((r) => (r.item as MemoryItem & MemoryItemLike).vec?.length === 1024);
    ok(dimOk, '库里恢复的向量维度正确（BLOB 真的回来了）', rows.map((r) => (r.item as MemoryItem & MemoryItemLike).vec?.length ?? 0).join(',').slice(0, 40));
    const hits = await store2.recall(pid, '他住在哪儿', 3);
    ok(hits.some((h) => h.text.includes('上海')), '重开后语义召回依旧命中上海',
      hits.length ? `top1: ${hits[0].text.slice(0, 20)}` : '（无结果）');
    // 未设角色的空 deps：all() 不应把向量序列化出去（面板会炸）
    const lean = store2.all(pid)[0] as Record<string, unknown>;
    ok(!('vec' in lean), 'all() 输出不含向量字段（面板序列化安全）');
  }

  persist.close();
  rmSync(DB, { force: true });

  console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 全部通过'}`);
  process.exit(failed ? 1 : 0);
}

// Provider/ModelDef 只在类型里引用（防止 noUnusedLocals 之外的警告）：
void (0 as unknown as [Provider, ModelDef]);
main().catch((err) => {
  console.error('✗ 测试脚本异常：', err);
  process.exit(1);
});
