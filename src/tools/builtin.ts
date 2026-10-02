import type { MemoryStore } from '../memory/store.ts';
import type { Orchestrator } from '../orchestrator/orchestrator.ts';
import type { ToolRegistry } from './registry.ts';
import type { SearchFn } from './metaso.ts';
import { registerWeatherTool } from './weather.ts';

export interface BuiltinDeps {
  search: SearchFn;
}

/**
 * 前台工具白名单：数量少、都很快。
 * 超出白名单的一律走 delegate。
 */
export function registerBuiltinTools(
  reg: ToolRegistry,
  orch: Orchestrator,
  memory: MemoryStore,
  deps: BuiltinDeps,
): void {
  reg.register({
    name: 'time',
    description: '获取当前本地时间',
    schema: { type: 'object', properties: {} },
    timeoutMs: 300,
    run: async () => new Date().toLocaleString('zh-CN', { hour12: false }),
  });

  /** 天气（wttr.in，免费免 key）；不传地点就用默认地点 */
  registerWeatherTool(reg, { defaultLocation: '常德' });

  /** 秘塔 AI 搜索（真） */
  reg.register({
    name: 'search',
    description: '联网搜索（秘塔 AI 搜索），返回标题 / 摘要 / 链接',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', description: 'webpage | document | scholar | image | video | podcast' },
        size: { type: 'number' },
      },
      required: ['query'],
    },
    timeoutMs: 20_000,
    run: async (args: { query: string; scope?: string; size?: number }) => {
      const r = await deps.search({ query: args.query, scope: args.scope, size: args.size });
      if (r.hits.length === 0) return `没有搜到「${args.query}」的结果`;
      return r.hits
        .slice(0, 4)
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.summary.slice(0, 160)}\n   ${h.link}`)
        .join('\n');
    },
  });

  reg.register({
    name: 'memory_recall',
    description: '补查这个人的记忆（自动召回之外）',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    timeoutMs: 300,
    run: async (args: { query: string }, ctx) => memory.recall(ctx.personId, args.query, 5).map((h) => h.text),
  });

  reg.register({
    name: 'memory_remember',
    description: '记下一件事（短期记忆，前台可写）',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['text'],
    },
    timeoutMs: 300,
    run: async (args: { text: string; tags?: string[] }, ctx) => {
      memory.write(ctx.personId, {
        text: args.text,
        tags: args.tags ?? ['hot'],
        channel: ctx.channel,
        at: Date.now(),
        hot: true,
      });
      return { ok: true };
    },
  });

  /** 内置 delegate：立即回执，不阻塞 */
  reg.register({
    name: 'delegate',
    description: '把需要多步 / 耗时的任务交给后台，立即返回回执',
    schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    timeoutMs: 300,
    run: async (args: { prompt: string }, ctx) => {
      const { taskId } = orch.dispatch({
        personId: ctx.personId,
        origin: { personId: ctx.personId, channel: ctx.channel, externalId: '' },
        prompt: args.prompt,
      });
      return { accepted: true, taskId };
    },
  });

  reg.register({
    name: 'task_status',
    description: '查某个后台任务的状态 / 进度',
    schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    timeoutMs: 300,
    run: async (args: { taskId: string }) => orch.status(args.taskId) ?? { error: '没有这个任务' },
  });

  reg.register({
    name: 'list_tasks',
    description: '列出这个人当前在跑的任务',
    schema: { type: 'object', properties: {} },
    timeoutMs: 300,
    run: async (_args: unknown, ctx) => orch.list(ctx.personId),
  });
}
