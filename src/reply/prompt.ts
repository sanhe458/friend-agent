import type { ChatMessage } from '../models/client.ts';
import type { MemoryItem } from '../memory/store.ts';
import { PERSONA } from './persona.ts';

/** 组装 prompt：人格基底（共享）+ 这个人的记忆（私有）+ 会话历史 + 当前这句 */
export function buildMessages(opts: {
  personName: string;
  personId: string;
  channel: string;
  memories: MemoryItem[];
  history: ChatMessage[];
  userText: string;
  /** 这套对话用的人格正文（由引擎解析后传入；不传则用内置） */
  persona?: string;
}): ChatMessage[] {
  const memBlock = opts.memories.length
    ? opts.memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
    : '（暂时没有）';
  const persona = (opts.persona ?? '').trim() || PERSONA;

  const sys: ChatMessage = {
    role: 'system',
    content:
      `${persona}\n\n---\n` +
      `当前对话对象：${opts.personName}（personId=${opts.personId}，来自通道 ${opts.channel}）\n` +
      `关于他的记忆（按需使用；没有的就别说，别编）：\n${memBlock}`,
  };

  return [sys, ...opts.history, { role: 'user', content: opts.userText }];
}
