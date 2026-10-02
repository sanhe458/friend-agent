import type { ToolRegistry } from './registry.ts';
import type { Scheduler } from '../core/schedule.ts';
import type { IdentityService } from '../core/person.ts';

/**
 * 定时任务的 agent 工具——**让 agent 能主动给自己排活**。
 * 例：用户说“明天早上 8 点提醒我开会”，agent 自己调 schedule_task。
 */
export function registerScheduleTools(reg: ToolRegistry, sched: Scheduler, identity: IdentityService): void {
  /** 把“当前这个人”解析成可用于投递的 channel + externalId */
  const targetOf = (personId: string, preferChannel: string) => {
    const p = identity.all().find((x) => x.id === personId);
    if (!p) return undefined;
    const pick = p.bindings.find((b) => b.channel === preferChannel)
      ?? p.bindings.find((b) => b.channel === p.preferredChannel)
      ?? p.bindings[0];
    return pick ? { channel: pick.channel, to: pick.externalId } : undefined;
  };

  reg.register({
    name: 'schedule_task',
    description:
      '给自己排一个定时/周期任务，到点会主动给这个人发消息。'
      + 'spec 写法：+30m（30 分钟后一次）、every:2h（每 2 小时）、daily:08:00（每天 8 点）、"0 8 * * *"（cron）。'
      + 'kind=say 时 text 是要发出去的原话；kind=ask 时 text 是给自己的提示词，到点你会再想一轮怎么说。',
    schema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: '时间规则，如 +30m / every:2h / daily:08:00 / "0 8 * * *"' },
        text: { type: 'string', description: 'say=要发的话；ask=给自己的提示词' },
        kind: { type: 'string', enum: ['say', 'ask'], description: '默认 say' },
        title: { type: 'string', description: '给这个任务起个短名，方便以后取消' },
      },
      required: ['spec', 'text'],
    },
    timeoutMs: 1500,
    run: async (args: any, ctx) => {
      const t = targetOf(ctx.personId, ctx.channel);
      if (!t) throw new Error('这个人还没有可用通道，无法排任务');
      const job = sched.add({
        spec: String(args.spec ?? ''),
        text: String(args.text ?? ''),
        kind: args.kind === 'ask' ? 'ask' : 'say',
        ...(args.title ? { title: String(args.title) } : {}),
        personId: ctx.personId,
        channel: t.channel,
        to: t.to,
      });
      return `已排好：${job.title}（${job.spec}），下次 ${new Date(job.nextAt).toLocaleString('zh-CN', { hour12: false })}，编号 ${job.id}`;
    },
  });

  reg.register({
    name: 'list_scheduled',
    description: '列出当前所有定时任务（编号、规则、下次时间、类型）',
    schema: { type: 'object', properties: {} },
    timeoutMs: 800,
    run: async () => {
      const jobs = sched.list();
      if (!jobs.length) return '现在没有任何定时任务。';
      return jobs.map((j) =>
        `${j.id}｜${j.title}｜${j.spec}｜${new Date(j.nextAt).toLocaleString('zh-CN', { hour12: false })}｜${j.kind === 'ask' ? '触发思考' : '直接发话'}｜${j.enabled ? '启用' : '已停'}`,
      ).join('\n');
    },
  });

  reg.register({
    name: 'cancel_scheduled',
    description: '按编号取消一个定时任务',
    schema: { type: 'object', properties: { id: { type: 'string', description: '任务编号，如 j_ab12cd' } }, required: ['id'] },
    timeoutMs: 800,
    run: async (args: any) => (sched.remove(String(args.id)) ? `已取消 ${args.id}` : `没找到编号 ${args.id}`),
  });
}
