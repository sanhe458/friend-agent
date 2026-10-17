/**
 * 免费车道模型目录。内置一份静态底表；启动时尝试向上游 /zen/v1/models
 * 拉实时目录，失败就用这份兜底。
 *
 * 与上游 zen-gate-server（internal/lane/catalog.go）保持一致的部分：
 * - 能力表（上下文 / 输出上限 / 视觉 / 是否可关思考）按模型族正则匹配；
 * - 线协议由 upstream.wireFor 决定（chat / responses / messages / systemone），
 *   以前这里一律写死 chat，muse-spark 与 union-alpha 会被发到错的端点；
 * - 地区敏感标记（muse-spark 系在国内出口会被地区门拦）。
 */
import { baseModelId, isSystemOneModel, wireFor, type Wire } from './upstream.ts';

export interface ModelInfo {
  id: string;
  name: string;
  blurb: string;
  wire: Wire;
  /** System One 判定模型（Jev 型）：不做内容生成，走 /zen/v1/systemone */
  systemOne: boolean;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  /** 思考关不掉：思考与正文共用一个输出预算 */
  canDisableThinking: boolean;
  /** 地区敏感：国内出口实测会被地区门拦（面板上要标注，不能静默消失） */
  regionSensitive: boolean;
}

type Cap = {
  re: RegExp;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  canDisableThinking: boolean;
};

// 顺序有意义：先匹配到先生效（mimo v2.6 → v2.5 → 通用 mimo）
const CAPABILITIES: Cap[] = [
  { re: /^mimo.*v2\.6/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072, canDisableThinking: false },
  { re: /^mimo.*v2\.5/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072, canDisableThinking: false },
  { re: /^mimo/, vision: true, reasoning: true, contextWindow: 262_144, maxOutput: 131_072, canDisableThinking: true },
  { re: /^muse.?spark/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072, canDisableThinking: true },
  // NVIDIA 的 3.5 代起带 VL（视觉），3.0 不带
  { re: /^nemotron.*(?:3\.5|vl)/, vision: true, reasoning: true, contextWindow: 128_000, maxOutput: 32_768, canDisableThinking: true },
  { re: /^nemotron/, vision: false, reasoning: true, contextWindow: 128_000, maxOutput: 32_768, canDisableThinking: true },
  { re: /^ling/, vision: false, reasoning: true, contextWindow: 262_144, maxOutput: 32_768, canDisableThinking: true },
  { re: /^space.?bunny/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 65_536, canDisableThinking: true },
  { re: /^union/, vision: true, reasoning: false, contextWindow: 262_144, maxOutput: 131_072, canDisableThinking: true },
  { re: /^deepseek/, vision: false, reasoning: true, contextWindow: 1_048_576, maxOutput: 65_536, canDisableThinking: true },
  { re: /^longcat/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 32_768, canDisableThinking: true },
  { re: /^fledge/, vision: false, reasoning: true, contextWindow: 131_072, maxOutput: 32_768, canDisableThinking: true },
  // Jev 型判定模型：32768 / 4096，只答结构化判定
  { re: /^jev/, vision: false, reasoning: false, contextWindow: 32_768, maxOutput: 4_096, canDisableThinking: true },
];

const REGION_SENSITIVE_RES = [/^muse.?spark/];

const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free']);
const FREE_LANE_RE = /(?:^|[-_])free(?:$|[-_.])/;

/** 这个 id 是否在免费车道上（网关目录混着付费 id，只有免费档免 key 可答） */
export function isFreeLane(modelId: string): boolean {
  const base = baseModelId(modelId);
  if (ALWAYS_FREE.has(base)) return true;
  return FREE_LANE_RE.test(base);
}

const DISPLAY_NAMES: Record<string, string> = {
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'ling-3.1-flash-free': 'Ling 3.1 Flash',
  'space-bunny-free': 'Space Bunny',
  'union-alpha': 'Union Alpha',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'longcat-2.5-preview-free': 'LongCat 2.5 Preview',
  'fledge-alpha-free': 'Fledge Alpha',
  'jev-1.13-free': 'Jev 1.13',
};

const BLURBS: Record<string, string> = {
  'mimo-v2.6-flash-free': '小米开源王牌：开源权重智能指数第一、Code Arena 前十，整体逼近 GPT-5 级主力，1M 上下文。推荐 ★★★★★（默认主力）',
  'mimo-v2.5-free': '小米上一代旗舰，1M 上下文、agent 稳；能力在 GPT-4.5~5 之间，已被 V2.6 全面接替。推荐 ★★★（备用）',
  'muse-spark-1.3-contributor-free': 'Meta 编程特化模型，官方对标 GPT-5.6 Sol，编码上限高；但 CN 出口实测被地区门拦。推荐 ★★★★（有海外出口再开）',
  'muse-spark-1.3-free': 'Meta 编程特化模型（非贡献者版），编码上限高；CN 出口实测被地区门拦。推荐 ★★★★（有海外出口再开）',
  'muse-spark-1.2-contributor-free': 'Muse Spark 上一代编程模型，同为 GPT-5 级定位；CN 出口地区受限。推荐 ★★★',
  'nemotron-3-ultra-free': 'NVIDIA 开源旗舰，口碑平平（约 GPT-4.5 水平）；国内直连最稳。推荐 ★★★（稳定备选）',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 轻快版，适合快问快答与短任务，约 GPT-4.5 级。推荐 ★★★',
  'nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL：带视觉输入的旗舰款，图片问答/截图理解可用。推荐 ★★★☆',
  'beam-free': '新上架的免费模型（来头未公开），先按 GPT-4.5 级试水。推荐 ★★★',
  'glm-5.3-flash-free': '智谱 GLM 5.3 Flash：轻量快答路线，中文任务顺滑。推荐 ★★★★',
  'ling-3.0-flash-fin-free': '蚂蚁 Ling 3.0 Flash：256K 上下文、开源权重，轻快可靠，约 GPT-4.5~5。推荐 ★★★★',
  'ling-3.1-flash-free': '蚂蚁 Ling 3.1 迭代版，同系轻快路线，日常任务顺滑。推荐 ★★★★',
  'space-bunny-free': '匿名 1M 上下文模型，OpenCode 用量榜第一、社区口碑好，来头未公开。推荐 ★★★★☆',
  'union-alpha': 'r/opencode 社区常推的免费模型，综合约 GPT-4.5+ 水平。推荐 ★★★★',
  'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash：V4 Flash 的迭代版，速度路线不变，指令跟随更稳。推荐 ★★★★★',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash：速度优先，首字快 40-60%、输出 ~214 tok/s，1M 上下文，综合对位 GPT-5 级。推荐 ★★★★★（速度之王）',
  'longcat-2.5-preview-free': '美团 LongCat 2.5 预览：万亿级动态稀疏 MoE、百万上下文。推荐 ★★★★',
  'fledge-alpha-free': '新上架的神秘面孔，社区评价还少；先按 GPT-4.5 级试水。推荐 ★★★（尝鲜）',
  'jev-1.13-free': 'TypeSafe AI 的 System One 判定模型：只答 choice/score/noul 三类结构化决策，不做内容生成，给 Agent 当意图/情绪判定层。推荐 ★★（别拿来聊天）',
};

function capFor(base: string): Cap {
  for (const c of CAPABILITIES) if (c.re.test(base)) return c;
  return {
    re: /./, vision: false, reasoning: true,
    contextWindow: 131_072, maxOutput: 32_768, canDisableThinking: true,
  };
}

export function displayName(modelId: string): string {
  const base = baseModelId(modelId);
  return DISPLAY_NAMES[base]
    ?? base.split(/[-_.]/).filter(Boolean)
      .map((w) => (/^[0-9]/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** 由裸 id 造一份目录条目（未知模型也能兜底出条目） */
export function modelInfo(id: string): ModelInfo {
  const base = baseModelId(id);
  const cap = capFor(base);
  const systemOne = isSystemOneModel(base);
  return {
    id: base,
    name: displayName(base),
    blurb: BLURBS[base] ?? '',
    wire: systemOne ? 'systemone' : wireFor(base),
    systemOne,
    vision: cap.vision,
    reasoning: cap.reasoning,
    contextWindow: cap.contextWindow,
    maxOutput: cap.maxOutput,
    canDisableThinking: cap.canDisableThinking,
    regionSensitive: REGION_SENSITIVE_RES.some((re) => re.test(base)),
  };
}

/** 上游目录（可能是付费 + 免费混排）→ 只留免费车道、按 base id 去重、保持原顺序 */
export function buildCatalog(ids: string[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const raw of ids) {
    const id = String(raw ?? '').trim();
    if (!id || !isFreeLane(id)) continue;
    const base = baseModelId(id);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(modelInfo(base));
  }
  return out;
}

/** 静态底表：拉不到上游目录时兜底 */
export const STATIC_CATALOG: ModelInfo[] = [
  // 顺序 = 默认 failover 优先级（靠前先被挑中），2026-10-17 按上游 /zen/v1/models 实测更新
  'mimo-v2.6-flash-free',
  'deepseek-v4.1-flash-free',
  'deepseek-v4-flash-free',
  'space-bunny-free',
  'glm-5.3-flash-free',
  'union-alpha',
  'ling-3.0-flash-fin-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'longcat-2.5-preview-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'muse-spark-1.3-contributor-free',
  'jev-1.13-free',
].map(modelInfo);
