import type { ChatMessage } from '../models/client.ts';

/** 粗估 token：CJK 约 1 字 1 token，其余约 4 字符 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x2e80 && c <= 0x9fff) cjk += 1;
  }
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.0 + other * 0.28);
}

/** 估算整段消息的 token（含每条消息的固定开销） */
export function estimateMessages(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4;
    n += estimateTokens(m.content ?? '');
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return n;
}

export function messageText(m: ChatMessage): string {
  const who = m.role === 'user' ? '对方' : m.role === 'assistant' ? '你' : m.role === 'tool' ? '工具' : '系统';
  return `${who}：${m.content ?? ''}`;
}
