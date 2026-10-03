import type { ToolRegistry } from './registry.ts';
import type { IdentityService } from '../core/person.ts';

/**
 * 跨对话人物归并的工具——**让 agent 在聊天里就能办这件事**。
 *
 * 场景：用户在新对话里说「我是 QQ 上的奶娃」→ agent 调 link_conversation
 *      → 验证码发到 QQ 那个对话 → 用户回到本对话回 6 位数字 → 自动合并。
 */
export function registerIdentityTools(
  reg: ToolRegistry,
  identity: IdentityService,
  sendTo: (channel: string, to: string, text: string) => Promise<void>,
): void {
  /**
   * 当前对话的 externalId。
   * ⚠️ 优先用 ToolCtx.externalId —— 从 bindings 反查会在「一个人在同一通道有多个对话」
   *    时拿错（比如 QQ 私聊 + QQ 群都绑在同一个人身上），归并就会认错对象。
   */
  const currentExternalId = (ctx: { personId: string; channel: string; externalId?: string }) => {
    if (ctx.externalId) return ctx.externalId;
    const p = identity.all().find((x) => x.id === ctx.personId);
    return p?.bindings.find((b) => b.channel === ctx.channel)?.externalId;
  };

  reg.register({
    name: 'list_people',
    description: '列出已知的人物档案：编号、称呼、以及他有哪些对话（通道:身份）。用来找“他另一个账号是哪一个”。',
    schema: { type: 'object', properties: {} },
    timeoutMs: 800,
    run: async () => {
      const ps = identity.all();
      if (!ps.length) return '目前还没有任何人物档案。';
      // 标出重名：重名时选人会选错，必须提醒 AI
      const cnt = new Map<string, number>();
      for (const p of ps) cnt.set(p.displayName.trim(), (cnt.get(p.displayName.trim()) ?? 0) + 1);
      return ps.map((p) => {
        const dup = (cnt.get(p.displayName.trim()) ?? 0) > 1 ? '⚠重名' : '';
        return `${p.id}｜${p.displayName}${dup}｜${p.bindings.map((b) => b.channel + ':' + b.externalId).join(' , ')}${p.preferredChannel ? '｜惯用 ' + p.preferredChannel : ''}`;
      }).join('\n');
    },
  });

  reg.register({
    name: 'link_conversation',
    description:
      '把「当前这个对话」和「另一个已存在的对话」认成同一个人（跨通道同一个人时用）。'
      + 'person 参数填 list_people 里的编号，或那个人的称呼。'
      + '调用后验证码会发到对方那个对话里，用户需要**在当前对话**回这 6 位数字才会真正合并。',
    schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: '目标人物编号（p_xxx）或称呼，来自 list_people' },
      },
      required: ['person'],
    },
    timeoutMs: 1200,
    run: async (args: any, ctx) => {
      const key = String(args.person ?? '').trim();
      if (!key) throw new Error('要说明和哪个人/哪个对话归并');

      const me = currentExternalId(ctx);
      if (!me) throw new Error('当前对话还没建档，无法归并');

      const all = identity.all();
      const target = all.find((p) => p.id === key)
        ?? all.find((p) => p.displayName === key)
        ?? all.find((p) => p.bindings.some((b) => b.channel + ':' + b.externalId === key))
        ?? all.find((p) => p.displayName.includes(key));
      if (!target) throw new Error(`没找到「${key}」，先用 list_people 看看有哪些档案`);

      // 目标方必须是“另一个对话”，不能是当前这个
      const known = target.bindings.find((b) => !(b.channel === ctx.channel && b.externalId === me));
      if (!known) throw new Error('那就是当前这个对话本身，不用归并');

      const r = identity.requestMerge(
        { channel: ctx.channel as any, externalId: me },
        { channel: known.channel, externalId: known.externalId },
      );
      // ⚠️ 必须真的把码发过去——之前只算出码就回“已发”，导致“它说发了但对方没收到”
      let sent = '已发送';
      try {
        await sendTo(
          known.channel,
          known.externalId,
          `【身份验证】\n验证码：${r.code}\n\n请到 ${ctx.channel} 那个对话里把上面 6 位数字回给机器人（10 分钟内有效）。`,
        );
      } catch (err) {
        sent = '⚠️ 发送失败：' + (err as Error).message;
      }
      return `验证码 ${r.code} 发往 ${known.channel}（${known.externalId.slice(0, 12)}…）：${sent}。\n请让用户回到**当前这个对话**把 ${r.code} 回给我，回对了就自动合并。`;
    },
  });

  reg.register({
    name: 'link_status',
    description: '查当前对话有没有正在等待确认的归并验证码',
    schema: { type: 'object', properties: {} },
    timeoutMs: 600,
    run: async (_args: any, ctx) => {
      const me = currentExternalId(ctx);
      if (!me) return '当前对话还没建档。';
      const pend = identity.pendingFor({ channel: ctx.channel as any, externalId: me });
      if (!pend) return '当前对话没有等待确认的归并。';
      const left = Math.max(0, Math.round((pend.expiresAt - Date.now()) / 1000));
      return `有：验证码 ${pend.code}，还剩 ${left}s，在本对话里回这 6 位数字即可合并。`;
    },
  });

  reg.register({
    name: 'set_person_name',
    description:
      '给人物档案改称呼（就是面板「人 / 身份」里那个显示名）。'
      + '不传 person 就是改**当前正在跟你说话的这个人**的称呼（用户说“叫我小明”时用这个）。'
      + '称呼要能区别人：如果发现重名，后面加个区分（如「小明(QQ)」），不要留两个一模一样的。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '新的称呼，建议不超过 12 个字' },
        person: { type: 'string', description: '可选：人物编号或现有称呼；不传 = 当前对话的人' },
      },
      required: ['name'],
    },
    timeoutMs: 1200,
    run: async (args: any, ctx) => {
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('称呼不能为空');

      let pid = ctx.personId;
      if (args.person) {
        const key = String(args.person).trim();
        const all = identity.all();
        const hit = all.filter((p) => p.id === key || p.displayName.trim() === key);
        const loose = hit.length ? hit : all.filter((p) => p.displayName.includes(key));
        if (!loose.length) throw new Error(`没找到「${key}」，先用 list_people 看看`);
        if (loose.length > 1) {
          return `「${key}」对上了多份档案，请改用编号：\n` + loose.map((p) => `  ${p.id}｜${p.displayName}｜${p.bindings.map((b) => b.channel + ':' + b.externalId).join(',')}`).join('\n');
        }
        pid = loose[0].id;
      }

      const { person, duplicateOf } = identity.setDisplayName(pid, name);
      const lines = [`已把 ${person.id} 的称呼改成「${person.displayName}」`];
      if (duplicateOf.length) {
        lines.push(`⚠️ 注意：现在已经有人叫「${person.displayName}」了（${duplicateOf.map((p) => p.id + '@' + p.bindings.map((b) => b.channel).join('/')).join('、')}）。`);
        lines.push('建议加个区分后缀（如「小明(QQ)」），否则以后选人会选错。');
      }
      return lines.join('\n');
    },
  });
}
