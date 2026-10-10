/**
 * 免费车道模型目录。小型网关只内置一份静态底表；
 * 启动时会尝试向上游 /zen/v1/models 拉实时目录，失败就用这份兜底。
 */
import { isSystemOneModel, type Wire } from './upstream.ts';

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
}

type Cap = { re: RegExp; vision: boolean; reasoning: boolean; contextWindow: number; maxOutput: number };

const CAPABILITIES: Cap[] = [
  { re: /^mimo.*v2\.6/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072 },
  { re: /^mimo.*v2\.5/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072 },
  { re: /^mimo/, vision: true, reasoning: true, contextWindow: 262_144, maxOutput: 131_072 },
  { re: /^muse.?spark/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072 },
  { re: /^nemotron/, vision: false, reasoning: true, contextWindow: 128_000, maxOutput: 32_768 },
  { re: /^ling/, vision: false, reasoning: true, contextWindow: 262_144, maxOutput: 32_768 },
  { re: /^space.?bunny/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 65_536 },
  { re: /^union/, vision: true, reasoning: false, contextWindow: 262_144, maxOutput: 131_072 },
  { re: /^deepseek/, vision: false, reasoning: true, contextWindow: 1_048_576, maxOutput: 65_536 },
  { re: /^longcat/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 32_768 },
  { re: /^fledge/, vision: false, reasoning: true, contextWindow: 131_072, maxOutput: 32_768 },
  // Jev 型判定模型：32768 / 4096，只答结构化判定
  { re: /^jev/, vision: false, reasoning: false, contextWindow: 32_768, maxOutput: 4_096 },
];

const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free']);
const FREE_LANE_RE = /(?:^|[-_])free(?:$|[-_.])/;

/** 这个 id 是否在免费车道上（网关目录混着付费 id，只有免费档免 key 可答） */
export function isFreeLane(modelId: string): boolean {
  if (ALWAYS_FREE.has(modelId)) return true;
  return FREE_LANE_RE.test(modelId);
}

const DISPLAY_NAMES: Record<string, string> = {
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'space-bunny-free': 'Space Bunny',
  'union-alpha': 'Union Alpha',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'longcat-2.5-preview-free': 'LongCat 2.5 Preview',
  'fledge-alpha-free': 'Fledge Alpha',
  'jev-1.13-free': 'Jev 1.13',
};

const BLURBS: Record<string, string> = {
  'mimo-v2.6-flash-free': '小米开源王牌，整体逼近 GPT-5 级主力，1M 上下文。推荐 ★★★★★（默认主力）',
  'deepseek-v4-flash-free': '速度之王：首字快 40-60%，1M 上下文。推荐 ★★★★★',
  'space-bunny-free': '匿名 1M 上下文模型，OpenCode 用量榜第一。推荐 ★★★★☆',
  'union-alpha': 'r/opencode 社区常推，综合约 GPT-4.5+。推荐 ★★★★',
  'ling-3.0-flash-fin-free': '蚂蚁 Ling 3.0 Flash：256K、轻快可靠。推荐 ★★★★',
  'jev-1.13-free': 'TypeSafe AI 的 System One 判定模型：只答 choice/score/noul 结构化判定，给 Agent 当意图/情绪判定层。推荐 ★★（别拿来聊天）',
};

function capFor(base: string): Cap {
  for (const c of CAPABILITIES) if (c.re.test(base)) return c;
  return { re: /./, vision: false, reasoning: true, contextWindow: 131_072, maxOutput: 8_192 };
}

export function displayName(modelId: string): string {
  return DISPLAY_NAMES[modelId]
    ?? modelId.split(/[-_.]/).filter(Boolean)
      .map((w) => /^[0-9]/.test(w) ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** 由裸 id 造一份目录条目（未知模型也能兜底出条目） */
export function modelInfo(id: string): ModelInfo {
  const cap = capFor(id);
  const systemOne = isSystemOneModel(id);
  return {
    id,
    name: displayName(id),
    blurb: BLURBS[id] ?? '',
    wire: systemOne ? 'systemone' : 'chat',
    systemOne,
    vision: cap.vision,
    reasoning: cap.reasoning,
    contextWindow: cap.contextWindow,
    maxOutput: cap.maxOutput,
  };
}

/** 静态底表：拉不到上游目录时兜底 */
export const STATIC_CATALOG: ModelInfo[] = [
  'mimo-v2.6-flash-free',
  'deepseek-v4-flash-free',
  'space-bunny-free',
  'union-alpha',
  'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free',
  'longcat-2.5-preview-free',
  'jev-1.13-free',
].map(modelInfo);
