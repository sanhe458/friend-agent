import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** MCP 服务器配置（stdio 传输，见 src/mcp/client.ts） */
export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** 给谁用：reply=前台回复模型，sub=子 agent；都勾/都不填 = 都能用（三河 2026-10-02） */
  audience?: Array<'reply' | 'sub'>;
  /** 每次工具调用超时（默认 30000） */
  timeoutMs?: number;
}

export interface Provider {
  id: string;
  label?: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ModelMeta {
  /** 上下文窗口（tokens） */
  contextWindow?: number;
  /** 单次最大输出（tokens） */
  maxOutput?: number;
  vision?: boolean;
  tools?: boolean;
  streaming?: boolean;
  /** 每 1M tokens 的价格 */
  inputPrice?: number;
  outputPrice?: number;
  /** 元数据来源：手动填 / 服务商端点 / models.dev 目录 */
  source?: 'manual' | 'api' | 'catalog';
  fetchedAt?: number;
  note?: string;
}

/**
 * 模型类型。
 * - chat      对话/推理（默认）
 * - asr       语音转文字
 * - tts       文字转语音（预留）
 * - vision    图像理解（预留）
 * - embedding 向量：记忆语义召回用
 * - rerank    重排序：记忆召回的精排段用
 */
export type ModelKind = 'chat' | 'asr' | 'tts' | 'vision' | 'embedding' | 'rerank';

export interface ModelDef {
  /** 唯一键，角色引用的是它 */
  id: string;
  label?: string;
  providerId: string;
  /** 真正发给 API 的 model 名 */
  model: string;
  meta?: ModelMeta;
  /** 可选：手动指定元数据端点，覆盖自动探测 */
  metaUrl?: string;
  /** 模型类型；不填 = chat（兼容旧配置） */
  kind?: ModelKind;
}

/** 上下文压缩策略：何时压、压到多少、最近几轮不动 */
export interface CompressionPolicy {
  triggerRatio: number;
  targetRatio: number;
  keepRecentTurns: number;
}

export const DEFAULT_COMPRESSION: CompressionPolicy = {
  triggerRatio: 0.75,
  targetRatio: 0.5,
  keepRecentTurns: 8,
};

/** 由模型元数据 + 策略算出预算（供上下文压缩用） */
export function contextBudget(meta: ModelMeta | undefined, policy: CompressionPolicy) {
  const ctx = meta?.contextWindow ?? 0;
  return {
    contextWindow: ctx,
    maxOutput: meta?.maxOutput ?? 0,
    triggerAt: ctx ? Math.floor(ctx * policy.triggerRatio) : 0,
    targetAt: ctx ? Math.floor(ctx * policy.targetRatio) : 0,
  };
}

export interface Roles {
  reply?: string;
  main?: string;
  sub?: string;
  /**
   * 语音转文字用的模型。**与对话角色分开**（三河 2026-10-02）——
   * 只有 kind='asr' 的模型能填这里；对话角色(reply/main/sub)也只应填 chat 模型。
   */
  asr?: string;
  /**
   * 记忆语义召回用的嵌入模型（kind='embedding'）。
   * 配了之后记忆 recall 走「向量召回 + 重排」；不配 = 维持原来的关键词召回。
   */
  embedding?: string;
  /** 记忆召回的精排模型（kind='rerank'）。可选：只有配了 embedding 才有用武之地 */
  rerank?: string;
}

/** 官方 QQ 机器人通道配置 */
export interface QQConfigFile {
  appId?: string;
  clientSecret?: string;
  minChars?: number;
  idleMs?: number;
  /** 开启 C2C 流式（默认关，稳定优先） */
  useStreaming?: boolean;
  /** 是否连 WebSocket 网关（默认开，用于在线状态） */
  gateway?: boolean;
}

export interface TelegramConfigFile {
  /** @BotFather 给的 token，形如 123456:AA... */
  token?: string;
  /** 长轮询等待秒数，默认 25 */
  pollSeconds?: number;
  /** 只处理这些 chat id（留空 = 谁都收） */
  allowFrom?: number[];
  /** 流式输出（编辑同一条消息）；默认关 */
  streaming?: boolean;
}

/**
 * 人格预设。
 *
 * 设计取向：AstrBot 是「框架驱动多个 Agent」，我们是「**一个 Agent + 多套人格预设**」——
 * 人格只是可切换的一层，不动 Agent 结构。
 * 切换粒度：全局默认（defaultPersonaId）+ **每个对话可单独覆盖**（Person.personaId）。
 */
export interface PersonaPreset {
  id: string;
  /** 显示名（也是它自我介绍用的名字） */
  name: string;
  /** 人格正文——会被拼到 system prompt 最前面 */
  prompt: string;
  /** 可选：刚认识时先说的话 */
  greeting?: string;
  /** 内置预设，不允许删 */
  builtin?: boolean;
}

export interface AppConfig {
  metasoApiKey?: string;
  metasoScope: string;
  searchSize: number;
  panelPort: number;
  /** 面板 API 的访问令牌；为空则不校验 */
  panelToken?: string;
  /** MCP 服务器列表（stdio）；工具挂进注册表，audience 决定给谁用 */
  mcp?: McpServerConfig[];
  providers: Provider[];
  models: ModelDef[];
  roles: Roles;
  compression: CompressionPolicy;
  qq?: QQConfigFile;
  telegram?: TelegramConfigFile;
  /** 人格预设（不配就用内置那个） */
  personas?: PersonaPreset[];
  /** 默认用哪套人格；不设 = 内置 */
  defaultPersonaId?: string;
  /** SQLite 路径；默认 data/friend.db */
  dbPath?: string;
}

export function configPath(): string {
  return process.env.FRIEND_AGENT_CONFIG ?? fileURLToPath(new URL('../config.local.json', import.meta.url));
}

/** 解析正整数环境变量/配置；非法（空串 / NaN / ≤0）就退回默认值 */
function intOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 环境变量 > config.local.json > 默认值。config.local.json 不进仓库 */
export function loadConfig(extraPath?: string): AppConfig {
  const path = extraPath ?? configPath();

  let file: Partial<AppConfig> = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>;
    } catch (err) {
      console.error('[config] config.local.json 解析失败，忽略：', (err as Error).message);
    }
  }

  return {
    metasoApiKey: process.env.METASO_API_KEY ?? file.metasoApiKey,
    metasoScope: process.env.METASO_SCOPE ?? file.metasoScope ?? 'webpage',
    // ⚠️ 以前直接 Number(...)：环境变量给空串时 Number('')=0 会让 searchSize 变 0，
    //    panelPort 变 0（= 随机端口，面板地址每次都变）。这里统一做“非法即默认”。
    searchSize: intOr(process.env.METASO_SIZE ?? file.searchSize, 5),
    panelPort: intOr(process.env.PANEL_PORT ?? file.panelPort, 8918),
    panelToken: process.env.PANEL_TOKEN ?? file.panelToken,
    providers: file.providers ?? [],
    models: file.models ?? [],
    roles: file.roles ?? {},
    // ⚠️ 这里是显式挑字段，新字段忘了加这里就会“配置写进去了但永远读不到”（MCP 第一次就踩了）
    ...(Array.isArray(file.mcp) ? { mcp: file.mcp } : {}),
    compression: { ...DEFAULT_COMPRESSION, ...(file.compression ?? {}) },
    ...(file.qq ? { qq: file.qq } : {}),
    ...(file.telegram ? { telegram: file.telegram } : {}),
    ...(file.personas ? { personas: file.personas } : {}),
    ...(file.defaultPersonaId ? { defaultPersonaId: file.defaultPersonaId } : {}),
    ...(process.env.FRIEND_DB ? { dbPath: process.env.FRIEND_DB } : (file.dbPath ? { dbPath: file.dbPath } : {})),
  };
}

/** 原子写回（tmp + rename，0600）；保留文件里已有的其它字段 */
export function saveConfig(patch: Partial<AppConfig>, extraPath?: string): AppConfig {
  const path = extraPath ?? configPath();

  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { /* ignore */ }
  }

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...file, ...patch }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return loadConfig(path);
}

/** 对外输出时永远不返回明文 key */
export function maskKey(key?: string): string {
  const k = String(key ?? '');
  if (!k) return '';
  // 短 key（≤8 位）全遮——只留尾 4 位等于把它泄了个干净
  if (k.length <= 8) return '••••（已隐藏）';
  return '••••' + k.slice(-4);
}
