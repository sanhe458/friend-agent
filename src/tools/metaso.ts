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

    const data = (await res.json()) as {
      credits?: number;
      webpages?: Array<{ title?: string; link?: string; summary?: string; date?: string; score?: string }>;
    };

    const hits: SearchHit[] = (data.webpages ?? []).map((w) => ({
      title: w.title ?? '(无标题)',
      link: w.link ?? '',
      summary: (w.summary ?? '').trim(),
      date: w.date || undefined,
      score: w.score,
    }));

    return { query, scope: body.scope, hits, credits: data.credits };
  };
}
