import type { AppConfig, ModelDef, Provider, Roles } from '../config.ts';
import { chatCompletion } from './client.ts';

/** 角色名。对话类(reply/main/sub)与语音类(asr)分开，不混用。 */
export type RoleName = 'reply' | 'main' | 'sub' | 'asr';

/** 这个角色能填哪种模型（kind）。对话角色只收 chat；asr 只收 asr。 */
export function kindForRole(role: RoleName): string {
  return role === 'asr' ? 'asr' : 'chat';
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
   * 拿一个可用的 ASR 模型（语音转文字）。
   * **优先看角色分配**（roles.asr，显式指定）；没配就退回「第一个 kind='asr' 的模型」，兼容旧配置。
   * 都没有就 undefined —— 绝不拿对话模型去转录。
   */
  asr(): { model: ModelDef; provider: Provider } | undefined {
    const byRole = this.roles().asr ? this.model(this.roles().asr as string) : undefined;
    const m = byRole && (byRole.kind ?? 'chat') === 'asr' ? byRole : this.byKind('asr')[0];
    if (!m) return undefined;
    const p = this.provider(m.providerId);
    return p ? { model: m, provider: p } : undefined;
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

  /** 真打一次，验证 key / baseUrl / 模型名 是否可用 */
  async test(modelId: string, prompt = '用一句话回答：你好'): Promise<{ ok: true; ms: number; text: string }> {
    const model = this.model(modelId);
    if (!model) throw new Error(`没有这个模型: ${modelId}`);
    const provider = this.provider(model.providerId);
    if (!provider) throw new Error(`模型 ${modelId} 对应的提供商不存在: ${model.providerId}`);

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
