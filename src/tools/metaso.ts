import type { AppConfig } from '../config.ts';

export interface SearchHit {
  title: string;
  link: string;
  summary: string;
  date?: string;
  score?: string;
}

export interface SearchResult {
  query: string;
  scope: string;
  hits: SearchHit[];
  credits?: number;
}

export type SearchFn = (args: { query: string; scope?: string; size?: number }) => Promise<SearchResult>;

const ENDPOINT = 'https://metaso.cn/api/v1/search';

/** 秘塔 AI 搜索：POST /api/v1/search，Bearer 鉴权 */
export function createMetasoSearch(cfg: Pick<AppConfig, 'metasoApiKey' | 'metasoScope' | 'searchSize'>): SearchFn {
  return async ({ query, scope, size }) => {
    if (!cfg.metasoApiKey) throw new Error('缺少秘塔 API key（METASO_API_KEY 或 config.local.json）');

    const body = {
      q: query,
      scope: scope ?? cfg.metasoScope,
      size: size ?? cfg.searchSize,
      includeSummary: true,
      conciseSnippet: false,
    };

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.metasoApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`秘塔返回 ${res.status}：${text.slice(0, 200)}`);
    }

    // ⚠️ 以前直接 `(await res.json())` 然后 `.map()`：秘塔挂掉时回一段 HTML，
    //    json() 抛一个光秃秃的 SyntaxError；或者 webpages 不是数组 → TypeError。
    //    两者都没有可读信息，模型只会看到"工具出错"。这里自己兜住，给可读原因。
    let data: { credits?: number; webpages?: unknown };
    try {
      data = (await res.json()) as { credits?: number; webpages?: unknown };
    } catch {
      throw new Error(`秘塔返回的不是 JSON（可能是网关错误页）：HTTP ${res.status}`);
    }
    const list = Array.isArray(data.webpages) ? data.webpages : [];

    const hits: SearchHit[] = list.map((w: any) => ({
      title: w?.title ?? '(无标题)',
      link: w?.link ?? '',
      summary: String(w?.summary ?? '').trim(),
      date: w?.date || undefined,
      score: w?.score,
    }));

    return { query, scope: body.scope, hits, credits: data.credits };
  };
}
