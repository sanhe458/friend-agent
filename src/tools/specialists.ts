import type { Orchestrator } from '../orchestrator/orchestrator.ts';
import type { Specialist } from '../orchestrator/specialists.ts';
import type { ToolRegistry } from './registry.ts';

/**
 * 专员 = 异步工具。
 * 和同步小工具同一张注册表，只是执行是异步的：立即返回 { accepted, taskId }。
 * 前台可以直接调，主 agent 也能调（同一注册表）。
 */
export function registerSpecialistTools(
  reg: ToolRegistry,
  orch: Orchestrator,
  specialists: Specialist[],
): void {
  for (const s of specialists) {
    reg.register({
      name: s.kind,
      description: `${s.label}（异步，立即回执）：${s.description}`,
      schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
      timeoutMs: 300,
      run: async (args: { prompt: string }, ctx) => {
        const r = orch.dispatch({
          personId: ctx.personId,
          origin: { personId: ctx.personId, channel: ctx.channel, externalId: '' },
          prompt: args.prompt,
          kind: s.kind,
        });
        return { accepted: true, ...r };
      },
    });
  }
}
