import type { AppConfig, ModelDef, Provider, Roles } from '../config.ts';
import { chatCompletion } from './client.ts';
import { embed } from './embedding.ts';
import { rerank } from './rerank.ts';

/** 角色名。对话类(reply/main/sub)与功能类(asr/embedding/rerank)分开，不混用。 */
export type RoleName = 'reply' | 'main' | 'sub' | 'asr' | 'embedding' | 'rerank';

/** 这个角色能填哪种模型（kind）。对话角色只收 chat；功能角色一一对应。 */
export function kindForRole(role: RoleName): string {
  return role === 'asr' || role === 'embedding' || role === 'rerank' ? role : 'chat';
}

/**
 * 模型注册表：提供商 + 模型 + 角色分配。
 * 配置由外部持有（面板改动后替换），所以这里拿的是 getter，保证读到最新。
 */
export class ModelRegistry {
  #get: () => AppConfig;

  constructor(getConfig: () => AppConfig) { this.#get = getConfig; }

  providers(): Provider[] { return this.#get().providers; }
  models(): ModelDef[] { return this.#get().models; }
  roles(): Roles { return this.#get().roles; }

  provider(id: string): Provider | undefined { return this.providers().find((p) => p.id === id); }
  model(id: string): ModelDef | undefined { return this.models().find((m) => m.id === id); }

  /** 按类型找模型（kind 不填 = chat）。以后加 tts/vision 都走这个 */
  byKind(kind: string): ModelDef[] { return this.models().filter((m) => (m.kind ?? 'chat') === kind); }

  /**
   * 功能类角色的通用解析：**优先看角色分配**（roles[kind]，显式指定）；
   * 没配就退回「第一个 kind 匹配的模型」，兼容旧配置。
   * 都没有就 undefined —— 绝不拿对话模型去干功能活。
   */
  #functional(kind: 'asr' | 'embedding' | 'rerank'): { model: ModelDef; provider: Provider } | undefined {
    const byRole = this.roles()[kind] ? this.model(this.roles()[kind] as string) : undefined;
    const m = byRole && (byRole.kind ?? 'chat') === kind ? byRole : this.byKind(kind)[0];
    if (!m) return undefined;
    const p = this.provider(m.providerId);
    return p ? { model: m, provider: p } : undefined;
  }

  /** 拿一个可用的 ASR 模型（语音转文字） */
  asr(): { model: ModelDef; provider: Provider } | undefined {
    return this.#functional('asr');
  }

  /** 拿一个可用的嵌入模型（记忆语义召回） */
  embedding(): { model: ModelDef; provider: Provider } | undefined {
    return this.#functional('embedding');
  }

  /** 拿一个可用的重排序模型（记忆召回精排） */
  rerank(): { model: ModelDef; provider: Provider } | undefined {
    return this.#functional('rerank');
  }

  /** 角色 → 具体提供商 + 模型 */
  resolve(role: RoleName): { model: ModelDef; provider: Provider } | undefined {
    const id = this.roles()[role];
    if (!id) return undefined;
    const model = this.model(id);
    if (!model) return undefined;
    const provider = this.provider(model.providerId);
    if (!provider) return undefined;
    return { model, provider };
  }

  /** 真打一次，验证 key / baseUrl / 模型名 是否可用（按模型类型选测法） */
  async test(modelId: string, prompt = '用一句话回答：你好'): Promise<{ ok: true; ms: number; text: string }> {
    const model = this.model(modelId);
    if (!model) throw new Error(`没有这个模型: ${modelId}`);
    const provider = this.provider(model.providerId);
    if (!provider) throw new Error(`模型 ${modelId} 对应的提供商不存在: ${model.providerId}`);
    const kind = model.kind ?? 'chat';

    // 功能类模型不能用 chat 测，各按各的真打法来（不然一堆看不懂的报错）
    if (kind === 'embedding') {
      const r = await embed({
        baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: model.model,
        input: ['记忆召回连通性测试'], timeoutMs: 30_000,
      });
      return { ok: true, ms: r.ms, text: `嵌入成功：维度 ${r.dims}` };
    }
    if (kind === 'rerank') {
      const r = await rerank({
        baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: model.model,
        query: '他喜欢什么', documents: ['他喜欢吃苹果', '他住在上海'], timeoutMs: 30_000,
      });
      const top = r[0];
      return { ok: true, ms: 0, text: `重排成功：top1 = 「${['他喜欢吃苹果', '他住在上海'][top?.index ?? 0]}」（${top?.score.toFixed(3)}）` };
    }

    const r = await chatCompletion({
      provider,
      model: model.model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 64,
      timeoutMs: 30_000,
    });
    return { ok: true, ms: r.ms, text: r.text.slice(0, 300) };
  }
}
