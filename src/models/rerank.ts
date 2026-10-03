/**
 * 重排序（rerank）—— 拿 query + 一批候选文本，按相关度精排。
 *
 * 走 Jina / Cohere 兼容的 `POST {baseUrl}/rerank`：
 *   请求  { model, query, documents: string[], top_n }
 *   响应  { results: [{ index, relevance_score }] }
 * 硅基流动（BAAI/bge-reranker-v2-m3 免费模型）、Jina、Cohere、vLLM 的
 * /rerank 都是（基本）这个形状，**模型名和地址全走配置**。
 *
 * 在本项目里的位置：记忆召回的**精排段**——向量召回粗筛出候选后，
 * 用它重排一次再取 top-k（只对几十条候选打分，一次调用，代价很小）。
 */

export interface RerankOptions {
  baseUrl: string;
  /** 未配置（undefined/空）时直接抛错，别把 "Bearer undefined" 发出去 */
  apiKey?: string;
  model: string;
  query: string;
  documents: string[];
  /** 最多返回几条（不传 = 全部） */
  topN?: number;
  timeoutMs?: number;
}

export interface RerankHit {
  /** 对应 documents 的下标 */
  index: number;
  /** 相关度分数（0~1 或任意实数，只在同一次结果内可比） */
  score: number;
}

/** 把 baseUrl 补成 rerank 端点（兼容带/不带 /v1、已写全路径的写法） */
export function rerankEndpoint(baseUrl: string): string {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/rerank$/.test(b)) return b;
  return b + '/rerank';
}

export async function rerank(opts: RerankOptions): Promise<RerankHit[]> {
  if (!opts.model) throw new Error('没有配置重排序模型');
  if (!opts.apiKey) throw new Error('重排序提供商没有配置 API key');
  const documents = (opts.documents ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  if (!documents.length || !opts.query) return [];

  const body: Record<string, unknown> = { model: opts.model, query: opts.query, documents };
  if (opts.topN && opts.topN > 0) body.top_n = Math.min(opts.topN, documents.length);

  const res = await fetch(rerankEndpoint(opts.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`重排失败(${res.status})：${raw.slice(0, 200)}`);

  let j: { results?: Array<{ index?: number; relevance_score?: number; score?: number }> };
  try { j = JSON.parse(raw); } catch { throw new Error(`重排响应不是 JSON：${raw.slice(0, 120)}`); }
  const results = Array.isArray(j.results) ? j.results : [];

  const hits: RerankHit[] = [];
  for (const r of results) {
    const index = Number(r.index);
    const score = Number(r.relevance_score ?? r.score);
    if (!Number.isInteger(index) || index < 0 || index >= documents.length) continue;
    if (!Number.isFinite(score)) continue;
    hits.push({ index, score });
  }
  // 按分数降序（有的服务不给排序）
  return hits.sort((a, b) => b.score - a.score);
}
