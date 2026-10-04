import type { Inbound, Person } from './types.ts';

/**
 * 命令（以 `/` 开头）。
 *
 * 规则（三河 2026-10-02）：
 * - **以 `/` 开头的消息不再当聊天**，一律不进回复引擎 —— 省 token，也不会让 AI 去"聊"指令。
 * - 认得的命令走自己的实现；**不认得的命令不回复**（静默，只留一条系统日志）。
 * - 命令不进对话历史，也不触发记忆写入。
 */

export interface CommandCtx {
  person: Person;
  msg: Inbound;
  args: string;
}

export interface CommandResult {
  /** 要发回去的文本；不填 = 不回复（静默执行） */
  reply?: string;
  /** 写进系统日志的一句话 */
  note: string;
}

export interface CommandDef {
  name: string;
  desc: string;
  run: (ctx: CommandCtx) => Promise<CommandResult> | CommandResult;
}

/** 从消息文本里解析命令；不是命令就返回 undefined */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const t = String(text ?? '').trim();
  if (!t.startsWith('/')) return undefined;
  // `/名字 [参数]`；名字允许字母数字下划线连字符与中文
  const m = /^\/([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*([\s\S]*)$/.exec(t);
  if (!m) return undefined;
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

/** 命令表：注册、查找、列出 */
export class CommandRegistry {
  #map = new Map<string, CommandDef>();

  register(c: CommandDef): this {
    this.#map.set(c.name.toLowerCase(), c);
    return this;
  }
  get(name: string): CommandDef | undefined { return this.#map.get(name.toLowerCase()); }
  list(): CommandDef[] { return [...this.#map.values()]; }
}

export interface CommandDeps {
  personBindings: (personId: string) => string[];
  status: () => Record<string, unknown>;
  tasks: (personId: string) => Array<{ id: string; kind: string; status: string; progress: number; prompt: string }>;
  jobs: (personId?: string) => Array<{ id: string; title: string; spec: string; enabled: boolean }>;
  /** 手动翻篇（/new）：立刻归档当前对话并提炼进记忆；返回 undefined = 没有可归档的对话 */
  newContext: (personId: string) => Promise<{ messages: number } | undefined>;
}

/** 内置命令；要加新命令就在这里 reg.register(...) */
export function defaultCommands(deps: CommandDeps): CommandRegistry {
  const reg = new CommandRegistry();

  reg.register({
    name: 'help',
    desc: '列出可用命令',
    run: () => ({
      reply: '可用命令：\n' + reg.list().map((c) => `/${c.name} — ${c.desc}`).join('\n'),
      note: 'help',
    }),
  });

  reg.register({
    name: 'ping',
    desc: '看看我在不在',
    run: () => ({ reply: '在。', note: 'pong' }),
  });

  reg.register({
    name: 'new',
    desc: '提前翻篇：当前对话立刻归档并提炼进记忆，开始新的上下文',
    run: async ({ person }) => {
      const r = await deps.newContext(person.id);
      return r
        ? { reply: `已翻篇 ✅ ${r.messages} 条消息已归档并提炼进记忆，这里是新的开始。`, note: `new → 翻篇 ${r.messages} 条` }
        : { reply: '当前没有可归档的对话，上下文本来就是干净的。', note: 'new → 无可归档' };
    },
  });

  reg.register({
    name: 'whoami',
    desc: '看你的身份和绑定了哪些对话',
    run: ({ person }) => {
      const bs = deps.personBindings(person.id);
      return {
        reply: `你是「${person.displayName}」（${person.id}）\n绑定的对话：\n` +
          (bs.length ? bs.map((b) => '· ' + b).join('\n') : '（还没有）'),
        note: `whoami → ${person.id}，${bs.length} 个绑定`,
      };
    },
  });

  reg.register({
    name: 'status',
    desc: '看运行状态（模型、任务、定时）',
    run: () => {
      const s = deps.status();
      const lines = Object.entries(s).map(([k, v]) => `· ${k}：${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      return { reply: '运行状态：\n' + lines.join('\n'), note: 'status' };
    },
  });

  reg.register({
    name: 'tasks',
    desc: '看你的子任务进度',
    run: ({ person }) => {
      const ts = deps.tasks(person.id);
      if (!ts.length) return { reply: '你还没有派过任务。', note: 'tasks → 0' };
      return {
        reply: ts.map((t) => `· [${t.kind}] ${t.status} ${t.progress}%\n  ${t.prompt.slice(0, 60)}`).join('\n'),
        note: `tasks → ${ts.length}`,
      };
    },
  });

  reg.register({
    name: 'jobs',
    desc: '看你的定时任务',
    run: ({ person }) => {
      const js = deps.jobs(person.id);
      if (!js.length) return { reply: '你没有定时任务。', note: 'jobs → 0' };
      return {
        reply: js.map((j) => `· ${j.enabled ? '▶' : '⏸'} ${j.title}（${j.spec}）`).join('\n'),
        note: `jobs → ${js.length}`,
      };
    },
  });

  return reg;
}
