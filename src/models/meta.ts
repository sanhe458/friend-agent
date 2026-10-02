import type { ModelMeta, Provider } from '../config.ts';

export interface FetchResult { found: true; from: string; meta: ModelMeta }

const num = (...vals: unknown[]): number | undefined => {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
};

const bool = (...vals: unknown[]): boolean | undefined => {
  for (const v of vals) if (typeof v === 'boolean') return v;
  return undefined;
};

const has = (arr: unknown, v: string): boolean | undefined =>
  Array.isArray(arr) ? arr.map(String).includes(v) : undefined;

/** 探测候选端点：baseUrl 可能带也可能不带 /v1 */
function candidates(baseUrl: string): string[] {
  const b = baseUrl.replace(/\/+$/, '');
  const noVer = b.replace(/\/v\d+$/, '');
  const out = [b + '/models'];
  out.push(noVer === b ? b + '/v1/models' : noVer + '/v1/models');
  if (noVer !== b) out.push(noVer + '/models');
  return [...new Set(out)];
}

/** 从各家五花八门的字段里抽出我们关心的元数据（端点若给了的话） */
function extract(h: Record<string, any>): ModelMeta {
  const arch = h?.architecture ?? {};
  const pricing = h?.pricing ?? h?.price ?? {};
  const modalities = arch?.input_modalities ?? h?.modalities ?? h?.input_modalities;
  const ctx = num(
    h?.context_length, h?.context_window, h?.max_context_length, h?.maxContextLength,
    h?.max_input_tokens, arch?.context_length, h?.top_provider?.context_length,
  );
  const out = num(
    h?.max_output_tokens, h?.max_tokens, h?.max_completion_tokens,
    h?.top_provider?.max_completion_tokens,
  );
  return {
    contextWindow: ctx,
    maxOutput: out,
    vision: bool(h?.vision, h?.supports_vision, h?.capabilities?.vision, has(modalities, 'image')),
    tools: bool(h?.tools, h?.supports_tools, h?.function_calling, h?.supports_function_calling, h?.capabilities?.tools),
    streaming: bool(h?.streaming, h?.supports_streaming, h?.capabilities?.streaming),
    inputPrice: num(pricing?.prompt, pricing?.input, h?.input_price),
    outputPrice: num(pricing?.completion, pricing?.output, h?.output_price),
    source: 'api',
    fetchedAt: Date.now(),
  };
}

/** 端点到底给没给有用的东西 */
const useful = (m: ModelMeta): boolean =>
  Boolean(m.contextWindow || m.maxOutput) || m.vision !== undefined || m.tools !== undefined;

/* ─────────────────────────────────────────────────────────────
 * 模型目录（models.dev）
 *
 * ⚠️ 2026-10-02 变更：**去掉了原来那张「内置模型家族表」**（src/models/known.ts）。
 *    那张表是拿各家文档的常见值按模型名正则匹配，**不是查来的**——三河指出
 *    「取不到就是取不到，还非要弄个内部表」，会把"没查到"伪装成"查到了"。
 *    现在改为查 **models.dev**（业界的模型目录，OpenCode / Cline 这类都从它取），
 *    这是**真实来源**，查不到就如实报错。
 *
 * 为什么不能只靠服务商的 /models：实测 agnes / treeapi / siliconflow 三家都只回
 * `{id, object, created, owned_by}`，**根本没有上下文长度和能力字段**，所以
 * 「解析端点」这条路注定取不到——必须有个目录来源。
 * ───────────────────────────────────────────────────────────── */
const CATALOG_URL = process.env.MODELS_CATALOG_URL ?? 'https://models.dev/api.json';
const CATALOG_TTL = 6 * 3600_000;
let catalogCache: { at: number; data: Record<string, any> } | null = null;
let catalogErr = '';

async function loadCatalog(): Promise<Record<string, any> | null> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.data;
  try {
    const r = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { catalogErr = `目录 HTTP ${r.status}`; return null; }
    const data = (await r.json()) as Record<string, any>;
    catalogCache = { at: Date.now(), data };
    catalogErr = '';
    return data;
  } catch (err) {
    catalogErr = (err as Error).message;
    return null;
  }
}

/** 名字归一化：去掉 vendor 前缀、小写、只留字母数字点（`deepseek-ai/DeepSeek-V4-Flash` → `deepseekv4flash`） */
const norm = (s: string): string =>
  String(s).toLowerCase().replace(/^.*\//, '').replace(/[^a-z0-9.]/g, '');

/** 在目录里按模型名找（各家命名不一，做归一化匹配；provider 名对得上的优先） */
function findInCatalog(
  data: Record<string, any>, modelName: string, providerId?: string,
): { pid: string; mid: string; m: Record<string, any> } | undefined {
  const want = norm(modelName);
  const hits: { pid: string; mid: string; m: Record<string, any> }[] = [];
  for (const [pid, prov] of Object.entries<any>(data ?? {})) {
    for (const [mid, m] of Object.entries<any>(prov?.models ?? {})) {
      if (norm(mid) === want) hits.push({ pid, mid, m });
    }
  }
  if (!hits.length) return undefined;
  const wantPid = norm(providerId ?? '');
  if (wantPid) {
    const pref = hits.find((h) => norm(h.pid) === wantPid) ?? hits.find((h) => norm(h.pid).includes(wantPid) || wantPid.includes(norm(h.pid)));
    if (pref) return pref;
  }
  return hits[0];
}

/** 目录条目 → 我们的 ModelMeta（只映射目录真给了的字段，不猜） */
function fromCatalog(hit: { pid: string; mid: string; m: Record<string, any> }): ModelMeta {
  const lim = hit.m?.limit ?? {};
  const cost = hit.m?.cost ?? {};
  const mods = hit.m?.modalities ?? {};
  const inputs: string[] = Array.isArray(mods?.input) ? mods.input : [];
  return {
    contextWindow: num(lim.context),
    maxOutput: num(lim.output),
    ...(inputs.length ? { vision: inputs.includes('image') } : {}),
    ...(hit.m.tool_call !== undefined ? { tools: Boolean(hit.m.tool_call) } : {}),
    inputPrice: num(cost.input),
    outputPrice: num(cost.output),
    source: 'catalog',
    fetchedAt: Date.now(),
    note: `models.dev · ${hit.pid}/${hit.mid}`,
  };
}

/**
 * 取元数据。**真来源只有两个**：服务商端点 → models.dev 目录。
 * 两个都取不到就**如实抛错**（不再有"内置表"这种东西把失败伪装成成功）。
 */
export async function fetchModelMeta(
  provider: Provider,
  modelName: string,
  metaUrl?: string,
): Promise<FetchResult> {
  const urls = metaUrl ? [metaUrl] : candidates(provider.baseUrl);
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;

  const notes: string[] = [];

  // ① 服务商端点（少数端点确实会带上下文/价格）
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { notes.push(`${u} → HTTP ${res.status}`); continue; }
      const data = (await res.json()) as any;
      const list: any[] = Array.isArray(data) ? data : (data?.data ?? data?.models ?? []);
      if (!Array.isArray(list) || list.length === 0) { notes.push(`${u} → 没有模型列表`); continue; }
      const hit =
        list.find((m) => String(m?.id ?? m?.name ?? m?.model ?? '') === modelName) ??
        list.find((m) => String(m?.id ?? m?.name ?? '').includes(modelName));
      if (!hit) { notes.push(`${u} → 列表里没有 ${modelName}`); continue; }
      const meta = extract(hit as Record<string, any>);
      if (useful(meta)) return { found: true, from: u, meta };
      notes.push(`${u} → 端点只回了 id，没有上下文/能力字段`);
    } catch (err) {
      notes.push(`${u} → ${(err as Error).message}`);
    }
  }

  // ② models.dev 目录（真实来源，查得到就是查得到）
  const cat = await loadCatalog();
  if (cat) {
    const hit = findInCatalog(cat, modelName, provider.id);
    if (hit) {
      const meta = fromCatalog(hit);
      if (useful(meta)) return { found: true, from: 'models.dev', meta };
      notes.push(`models.dev 有 ${hit.pid}/${hit.mid} 但没有上下文/输出字段`);
    } else {
      notes.push('models.dev 目录里没有这个模型');
    }
  } else {
    notes.push(`取不到目录${catalogErr ? '：' + catalogErr : ''}`);
  }

  // ③ 取不到就是取不到 —— 如实报错，不留假数据
  throw new Error('取不到元数据：' + (notes.slice(-3).join('；') || '未知原因'));
}
