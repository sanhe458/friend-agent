/**
 * OpenCode Zen 计划代理网关模块 · 公共出口。
 *
 * 两种用法：
 *
 * 1. 独立网关进程：`npm run zen-gate`（scripts/zen-gate.ts）
 *    把免费车道封装成 OpenAI / Anthropic / Responses 兼容接口，任何自定义 base_url 的客户端都能接。
 *
 * 2. 进程内调用：
 *    import { ZenLane } from './zen/index.ts';
 *    const lane = new ZenLane();
 *    await lane.chat({ model: 'mimo-v2.6-flash-free', messages: [...] });
 *    await lane.decide({ model: 'jev-1.13-free', state: '...', questions: {...} });
 */
export { ZenLane, catalogFrom, repairToolPairing, RecoveryMaxContinuationMs, RecoveryTotalTimeoutMs, RecoveryMaxOutputTokens } from './lane.ts';
export type { ChatMessage, ChatResult, DecideResult, ToolDef, LaneOptions } from './lane.ts';
export { createZenGate, startZenGate } from './gateway.ts';
export type { ZenGateOptions } from './gateway.ts';
export { STATIC_CATALOG, buildCatalog, isFreeLane, modelInfo, displayName } from './catalog.ts';
export type { ModelInfo } from './catalog.ts';
export { LEVELS, DEFAULT_LEVEL, MIN_BUDGET, budgetFor, budgetLadder, effortsFor, kilos, supportsEffort } from './effort.ts';
export type { Level, LevelBudget } from './effort.ts';
export { ThrottleBook } from './throttle.ts';
export type { ThrottleNote, ThrottleEpisode } from './throttle.ts';
export { StreamDecoder, windowTokens, CHECKPOINT_LIMIT, FINISH } from './decode.ts';
export type { StreamResult, DecodeHandlers, BlockType, Finish } from './decode.ts';
export {
  isSystemOneModel, wireFor, endpointFor, baseModelId, effortOf,
  sessionForConversation, requestIdFor, applyFingerprint, restoreToolName,
  mintSessionId, mintRequestId,
  DsmlScrubber, UpstreamError, UPSTREAM_BASE, CLIENT_UA, FINGERPRINT_TOOLS, QUARTET_DONORS,
} from './upstream.ts';
export type { Wire, FailureCode, Usage } from './upstream.ts';
