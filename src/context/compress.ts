import type { ChatMessage } from '../models/client.ts';
import { estimateMessages, messageText } from './tokens.ts';

export interface CompressResult {
  messages: ChatMessage[];
  compressed: boolean;
  before: number;
  after: number;
  dropped: number;
  summary?: string;
}

/**
 * 上下文压缩：超过 trigger 就把"中段"的旧对话摘要掉，保留 system + 最近 keepRecent 轮。
 * 摘要由模型生成；模型不可用时退化为直接丢弃（并在返回里说明）。
 */
export async function compressIfNeeded(opts: {
  messages: ChatMessage[];
  trigger: number;
  target: number;
  keepRecentTurns: number;
  summarize: (text: string) => Promise<string>;
}): Promise<CompressResult> {
  const { trigger, keepRecentTurns } = opts;
  const before = estimateMessages(opts.messages);
  if (before <= trigger) {
    return { messages: opts.messages, compressed: false, before, after: before, dropped: 0 };
  }

  const system = opts.messages.filter((m) => m.role === 'system');
  const body = opts.messages.filter((m) => m.role !== 'system');

  // 保留最近 keepRecentTurns 轮（user+assistant 各算一条）
  const keepCount = Math.max(2, keepRecentTurns * 2);
  let kept = body.slice(-keepCount);
  let dropped = body.slice(0, Math.max(0, body.length - keepCount));

  // 保证不把 tool 消息和它的 assistant(tool_calls) 拆开
  while (kept.length && kept[0].role === 'tool') kept = kept.slice(1);
  while (dropped.length && dropped[dropped.length - 1].role === 'assistant' && dropped[dropped.length - 1].tool_calls) {
    kept = [dropped.pop()!, ...kept];
  }

  if (dropped.length === 0) {
    return { messages: opts.messages, compressed: false, before, after: before, dropped: 0 };
  }

  const droppedText = dropped.map(messageText).join('\n').slice(0, 8000);
  let summary: string;
  try {
    summary = (await opts.summarize(droppedText)).trim();
  } catch {
    summary = '(摘要生成失败，这段历史已丢弃)';
  }

  const summaryMsg: ChatMessage = {
    role: 'system',
    content: `【早前对话摘要】（压缩自 ${dropped.length} 条消息）\n${summary}`,
  };

  let out = [...system, summaryMsg, ...kept];
  let after = estimateMessages(out);

  // 还是超 target：硬砍更早的
  if (opts.target > 0 && after > opts.target && kept.length > 4) {
    kept = kept.slice(-Math.max(4, Math.floor(kept.length / 2)));
    out = [...system, summaryMsg, ...kept];
    after = estimateMessages(out);
  }

  return { messages: out, compressed: true, before, after, dropped: dropped.length, summary };
}
