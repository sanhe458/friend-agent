import type { DailyContextManager } from '../context/daily.ts';
import { messageText } from '../context/tokens.ts';
import type { ChatMessage } from '../models/client.ts';
import type { ToolRegistry } from './registry.ts';

const roleLabel = (role: string): string =>
  role === 'user' ? '对方' : role === 'assistant' ? '你' : role === 'tool' ? '工具' : '系统';

/**
 * 归档查询（三河 2026-10-04）：上下文按天翻篇归档（保留 60 天）后，
 * AI 靠这个工具回看历史——按天列 / 按天读 / 按关键词搜。
 * 只查得到当前对话这个人自己的分片（与记忆隔离同一条约束）。
 */
export function registerArchiveTool(reg: ToolRegistry, daily: DailyContextManager): void {
  reg.register({
    name: 'archive_query',
    description:
      '查询与这个人的历史对话归档（上下文每天翻篇归档一次，保留 60 天）。' +
      'action=days 列出有哪些天的归档；action=read 读某天的完整对话（含当天摘要）；action=search 按关键词搜全部归档',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['days', 'read', 'search'], description: 'days=列出可查日期；read=读某天对话；search=关键词搜索' },
        day: { type: 'string', description: 'YYYY-MM-DD；read 时必填' },
        query: { type: 'string', description: '关键词（可多个，空格隔开）；search 时必填' },
        limit: { type: 'number', description: '最多返回多少条消息（read 默认 200 / search 默认 20）' },
      },
      required: ['action'],
    },
    timeoutMs: 5000,
    run: async (args: { action: string; day?: string; query?: string; limit?: number }, ctx) => {
      const pid = ctx.personId;

      if (args.action === 'days') {
        const days = daily.listDays(pid);
        if (!days.length) return '还没有历史归档（上下文按天归档，保留 60 天）';
        return [
          `可查询的归档共 ${days.length} 天（新 → 旧）：`,
          ...days.reverse().map((d) => `- ${d.day}（${d.count < 0 ? '文件损坏' : d.count + ' 条消息'}）`),
        ].join('\n');
      }

      if (args.action === 'read') {
        const day = String(args.day ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'day 要用 YYYY-MM-DD 格式；先用 action=days 看有哪些天';
        const doc = daily.readDay(pid, day);
        if (!doc) return `${day} 没有归档（或已超出 60 天保留期）`;
        const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 200), 500));
        const msgs = doc.messages ?? [];
        const head = [
          `【${day} 对话归档】共 ${msgs.length} 条${msgs.length > limit ? `，这里显示最近 ${limit} 条` : ''}`,
          doc.summary ? `当天摘要：${doc.summary}` : '',
          '---',
        ].filter(Boolean);
        return [...head, ...msgs.slice(-limit).map((m) => messageText(m as ChatMessage))].join('\n');
      }

      // search
      const query = String(args.query ?? '').trim();
      if (!query) return 'search 需要关键词（query）';
      const hits = daily.search(pid, query, Math.max(1, Math.min(Math.floor(args.limit ?? 20), 50)));
      if (!hits.length) return `归档里没搜到「${query}」（只搜这个人自己的归档，保留 60 天）`;
      return hits.map((h) => `${h.day} · ${roleLabel(h.role)}：${h.text}`).join('\n');
    },
  });
}
