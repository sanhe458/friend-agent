/**
 * OpenCode Zen 计划代理网关 · 启动入口。
 *
 *   node scripts/zen-gate.ts [-host 127.0.0.1] [-port 8788] [-key ofm-xxx]
 *
 * 启动后：
 *   API    http://127.0.0.1:8788/v1   （OpenAI 兼容；Jev 判定模型走 /v1/systemone）
 *   体检   POST /v1/probe {"model":"mimo-v2.6-flash-free"}
 */
import { startZenGate } from '../src/zen/index.ts';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

await startZenGate({
  host: arg('-host') || process.env.ZEN_GATE_HOST || '127.0.0.1',
  port: Number(arg('-port') || process.env.ZEN_GATE_PORT || 8788),
  apiKey: arg('-key') || process.env.ZEN_GATE_KEY || undefined,
});
