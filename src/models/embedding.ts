/**
 * 嵌入（embedding）—— 把文本变成向量，供记忆做语义召回。
 *
 * 走 OpenAI 兼容的 `POST {baseUrl}/embeddings`：
 *   请求  { model, input: string[] }
 *   响应  { data: [{ index, embedding: number[] }], usage }
 * 硅基流动（BAAI/bge-m3 等免费模型）、OpenAI、Jina、Ollama、one-api/new-api
 * 网关都是这个形状，所以**模型名和地址全走配置，换提供商不用改代码**。
 */

export interface EmbedOptions {
  baseUrl: string;
  /** 未配置（undefined/空）时直接抛错，别把 "Bearer undefined" 发出去 */
  apiKey?: string;
  model: string;
  /** 支持批量；调用方不用关心分批，这里按提供商惯例切开 */
  input: string[];
  timeoutMs?: number;
}

export interface EmbedResult {
  /** 顺序与 input 一一对应 */
  vectors: Float32Array[];
  /** 向量维度（取第一条的长度） */
  dims: number;
  ms: number;
}

/** 把 baseUrl 补成 embeddings 端点（兼容带/不带 /v1、已写全路径的写法） */
export function embeddingsEndpoint(baseUrl: string): string {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/embeddings$/.test(b)) return b;
  return b + '/embeddings';
}

/** 单次请求最多几条文本：部分服务商对批量有上限（硅基流动 32），留出余量 */
const BATCH_SIZE = 16;

export async function embed(opts: EmbedOptions): Promise<EmbedResult> {
  if (!opts.model) throw new Error('没有配置嵌入模型');
  if (!opts.apiKey) throw new Error('嵌入提供商没有配置 API key');
  const input = opts.input.filter((s) => typeof s === 'string' && s.length > 0);
  if (!input.length) return { vectors: [], dims: 0, ms: 0 };

  const t0 = Date.now();
  const vectors: Float32Array[] = [];

  for (let i = 0; i < input.length; i += BATCH_SIZE) {
    const batch = input.slice(i, i + BATCH_SIZE);
    const res = await fetch(embeddingsEndpoint(opts.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, input: batch }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`嵌入失败(${res.status})：${raw.slice(0, 200)}`);

    let j: { data?: Array<{ index?: number; embedding?: number[] }> };
    try { j = JSON.parse(raw); } catch { throw new Error(`嵌入响应不是 JSON：${raw.slice(0, 120)}`); }
    const data = Array.isArray(j.data) ? j.data : [];
    if (data.length !== batch.length) {
      throw new Error(`嵌入返回条数不符：要 ${batch.length} 条，回了 ${data.length} 条`);
    }
    // 有的服务乱序返回，靠 index 归位；没有 index 就当按序
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const d of ordered) {
      if (!Array.isArray(d.embedding) || !d.embedding.length) {
        throw new Error('嵌入返回里有空向量');
      }
      vectors.push(Float32Array.from(d.embedding));
    }
  }

  return { vectors, dims: vectors[0]?.length ?? 0, ms: Date.now() - t0 };
}

/** 余弦相似度（向量长度不等返回 0 —— 维度变了说明换过模型，没有可比性） */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
