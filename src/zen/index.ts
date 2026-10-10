/**
 * OpenCode Zen 计划代理网关模块 · 公共出口。
 *
 * 两种用法：
 *
 * 1. 独立网关进程：`npm run zen-gate`（scripts/zen-gate.ts）
 *    把免费车道封装成 OpenAI 兼容 /v1 接口，任何自定义 base_url 的客户端都能接。
 *
 * 2. 进程内调用：
 *    import { ZenLane } from './zen/index.ts';
 *    const lane = new ZenLane();
 *    await lane.chat({ model: 'mimo-v2.6-flash-free', messages: [...] });
 *    await lane.decide({ model: 'jev-1.13-free', state: '...', questions: {...} });
 */
export { ZenLane } from './lane.ts';
export type { ChatMessage, ChatResult, DecideResult, ToolDef, LaneOptions } from './lane.ts';
export { createZenGate, startZenGate } from './gateway.ts';
export type { ZenGateOptions } from './gateway.ts';
export { STATIC_CATALOG, isFreeLane, modelInfo, displayName } from './catalog.ts';
export type { ModelInfo } from './catalog.ts';
export {
  isSystemOneModel, wireFor, endpointFor, baseModelId, effortOf,
  sessionForConversation, requestIdFor, applyFingerprint, restoreToolName,
  mintSessionId, mintRequestId,
  DsmlScrubber, UpstreamError,
} from './upstream.ts';
export type { Wire, FailureCode } from './upstream.ts';
