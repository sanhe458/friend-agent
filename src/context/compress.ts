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

  // kept 的起点必须落在「安全边界」上：
  //   ① 不能是 tool 响应（它的发起方 assistant 在 dropped 里，孤零零没人认领）；
  //   ② 不能是「发了 tool_calls 却没跟着响应」的 assistant —— 多数端点会直接 400。
  //   （以前分两个 while：先把开头的 tool 丢掉、再把 assistant(tool_calls) 搬回 kept，
  //    恰好制造出 ② 说的孤儿 → 压缩后的下一轮必 400。）
  //   被挪走的消息统一 push 回 dropped，保证摘要能看到完整内容。
  while (
    kept.length &&
    (kept[0].role === 'tool' || (kept[0].role === 'assistant' && kept[0].tool_calls))
  ) {
    dropped.push(kept.shift()!);
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
