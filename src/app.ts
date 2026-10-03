import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.ts';
import { loadConfig } from './config.ts';
import type { Inbound, Outbound } from './core/types.ts';
import { Bus } from './core/bus.ts';
import { IdentityService } from './core/person.ts';
import { PersonQueue } from './core/queue.ts';
import { MemoryStore } from './memory/store.ts';
import { ToolRegistry } from './tools/registry.ts';
import { registerBuiltinTools } from './tools/builtin.ts';
import { registerBrowserTool } from './tools/browser.ts';
import { registerSpecialistTools } from './tools/specialists.ts';
import { Scheduler } from './core/schedule.ts';
import { parseCommand, defaultCommands } from './core/commands.ts';
import { McpManager } from './mcp/client.ts';
import { registerScheduleTools } from './tools/schedule.ts';
import { registerIdentityTools } from './tools/identity.ts';
import { TelegramAdapter } from './adapters/telegram.ts';
import { withBuiltin, BUILTIN_PERSONA } from './reply/persona.ts';
import type { PersonaPreset } from './config.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import type { TaskRunner } from './orchestrator/types.ts';
import { defaultSpecialists, GENERAL_PROMPT, makeRunner, type SpecialistModel } from './orchestrator/specialists.ts';
import { AdapterRegistry } from './adapters/adapter.ts';
import type { StreamHandle } from './adapters/adapter.ts';
import { MockAdapter } from './adapters/mock.ts';
import { QQAdapter } from './adapters/qq.ts';
import { ReplyEngine } from './reply/engine.ts';
import { createMetasoSearch, type SearchFn } from './tools/metaso.ts';
import { transcribe, bytesFromDataUrl } from './models/asr.ts';
import { ModelRegistry } from './models/registry.ts';
import { createPiHarness, type PiProviderEntry } from './harness/pi.ts';
import { createLocalHarness } from './harness/local.ts';
import { createSqlitePersistence, type Persistence } from './store/persist.ts';

export interface LogEntry {
  at: number;
  dir: 'in' | 'out' | 'sys';
  channel: string;
  personId?: string;
  to?: string;
  text: string;
}

export interface App {
  identity: IdentityService;
  memory: MemoryStore;
  queue: PersonQueue;
  orch: Orchestrator;
  tools: ToolRegistry;
  models: ModelRegistry;
  engine: ReplyEngine;
  adapters: AdapterRegistry;
  log: LogEntry[];
  /** 正在流式生成中的文本（personId → 累计全文），面板/对话页用它显示实时输出 */
  drafts: Map<string, string>;
  /** 配了官方 QQ 才有 */
  qq?: QQAdapter;
  /** 配了 Telegram token 才有 */
  telegram?: TelegramAdapter;
  /** 持久化（SQLite）；close() 时调用 persist.close() */
  persist: Persistence;
  /** 定时任务调度器 */
  sched: Scheduler;
  /** MCP 连接管理器（外部工具挂载/勾选给谁用） */
  mcp: McpManager;
  onLog: (cb: (e: LogEntry) => void) => () => void;
  inbound: (msg: Inbound) => Promise<void>;
  say: (channel: string, externalId: string, text: string) => Promise<void>;
  /** 直接给某个通道位置发一句（系统通知用，如归并验证码） */
  sendTo: (channel: string, to: string, text: string) => Promise<void>;
}

const DEFAULT_CHANNELS = ['panel', 'qq', 'telegram'];
/** 子 agent 的工作区：每个任务一个目录，Pi 的 cwd 就是它 */
const AGENT_WORKSPACE = fileURLToPath(new URL('../data/agents', import.meta.url));
const DB_PATH = fileURLToPath(new URL('../data/friend.db', import.meta.url));
const SUBAGENT_TIMEOUT_MS = 600_000;

export function createApp(opts: {
  channels?: string[];
  search?: SearchFn;
  models?: ModelRegistry;
  getConfig?: () => AppConfig;
} = {}): App {
  const getConfig = opts.getConfig ?? (() => loadConfig());

  // 落库：默认 SQLite，可通过 config.dbPath / 环境变量 FRIEND_DB 指定
  const persist = createSqlitePersistence(getConfig().dbPath ?? DB_PATH);

  const identity = new IdentityService(persist);
  // ⚠️ models 必须先于 memory 声明：MemoryStore 构造时会做向量 backfill，
  //    立即调用这里的 embedding()/rerank()（晚一行就是 TDZ ReferenceError）
  const models = opts.models ?? new ModelRegistry(getConfig);
  // 记忆的语义召回依赖模型注册表：每次用时现取（跟着配置热重载走），
  // 没配 embedding 模型 = 维持老的关键词召回，行为不变
  const memory = new MemoryStore(persist, {
    embedding: () => {
      const e = models.embedding();
      return e ? { baseUrl: e.provider.baseUrl, apiKey: e.provider.apiKey, model: e.model.model } : undefined;
    },
    rerank: () => {
      const r = models.rerank();
      return r ? { baseUrl: r.provider.baseUrl, apiKey: r.provider.apiKey, model: r.model.model } : undefined;
    },
  });
  const queue = new PersonQueue();
  const bus = new Bus();
  const tools = new ToolRegistry();
  const search = opts.search ?? createMetasoSearch(getConfig());

  // 日志要先于引擎建好：引擎的 notice 要写进来
  const log: LogEntry[] = [];
  const listeners = new Set<(e: LogEntry) => void>();
  const push = (e: LogEntry) => {
    log.push(e);
    if (log.length > 800) log.splice(0, log.length - 800);
    for (const l of listeners) {
      try { l(e); } catch { /* ignore */ }
    }
  };

  // ── 子 agent：两个 harness + 每类专员一个 runner ──────────
  const providerEntries = (): PiProviderEntry[] => {
    const c = getConfig();
    return (c.providers ?? []).map((p) => ({
      id: p.id,
      baseUrl: p.baseUrl,
      models: (c.models ?? []).filter((m) => m.providerId === p.id).map((m) => m.model),
    }));
  };

  const piHarness = createPiHarness(providerEntries);
  const localHarness = createLocalHarness({ models, tools });

  const modelFor = (prefer: Array<'main' | 'sub' | 'reply'>): SpecialistModel | undefined => {
    for (const role of prefer) {
      const hit = models.resolve(role);
      if (hit) {
        return {
          providerId: hit.provider.id,
          model: hit.model.model,
          baseUrl: hit.provider.baseUrl,
          apiKey: hit.provider.apiKey,
        };
      }
    }
    return undefined;
  };

  const specialists = defaultSpecialists();
  const runners: Record<string, TaskRunner> = {
    general: makeRunner({
      harness: piHarness,
      fallback: localHarness,
      model: () => modelFor(['main', 'sub']),
      workspace: AGENT_WORKSPACE,
      systemPrompt: GENERAL_PROMPT,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
    }),
  };
  for (const s of specialists) {
    // 要用到**本项目自定义工具**的专员必须跑 local harness
    // （pi 是外部 CLI，只看得到它自己的 read/bash/edit/write，看不到我们注册的工具）：
    //   deep_search → 用我们的秘塔 search
    //   browser     → 用我们的 browse（真浏览器）
    const primary = s.kind === 'deep_search' || s.kind === 'browser' ? localHarness : piHarness;
    runners[s.kind] = makeRunner({
      harness: primary,
      ...(primary === piHarness ? { fallback: localHarness } : {}),
      model: () => modelFor(['sub', 'main']),
      workspace: AGENT_WORKSPACE,
      ...(s.tools ? { tools: s.tools } : {}),
      ...(s.systemPrompt ? { systemPrompt: s.systemPrompt } : {}),
      timeoutMs: SUBAGENT_TIMEOUT_MS,
      // ⭐ 只有长任务专员开会话 + 分段推进（其余专员保持一次性、不留痕迹）
      ...(s.long ? { longRun: s.long } : {}),
    });
  }

  const orch = new Orchestrator({ runners, specialists, persist });

  // 工具要有 orch 才能注册 delegate
  registerBuiltinTools(tools, orch, memory, { search });
  // MCP：把外部工具挂进注册表（audience 决定给谁用，见 src/mcp/client.ts）
  // ⚠️ McpManager 的 log 收的是 string，得包成 LogEntry——以前直接把 push 传过去，
  //    字符串被塞进 LogEntry[]，面板日志页渲染出 undefined。
  const mcp = new McpManager(tools, (s) => push({ at: Date.now(), dir: 'sys', channel: 'mcp', text: s }));
  // 退出时收掉 MCP 子进程：不接的话，systemd 重启（SIGTERM）会留下逃逸的孤儿子进程（实测过）
  const mcpShutdown = () => { try { mcp.stopAll(); } catch { /* ignore */ } };
  process.once('exit', mcpShutdown);
  process.once('SIGTERM', mcpShutdown);
  process.once('SIGINT', mcpShutdown);
  // 启动就挂；单台失败只记日志，不拖垮主进程（但不能静默吞错——那样连日志都没有）
  mcp.applyAll(getConfig().mcp ?? []).catch((err) => {
    push({ at: Date.now(), dir: 'sys', channel: 'mcp', text: `[mcp] 启动挂载失败：${(err as Error).message}` });
  });
  // 真浏览器（无头 Chromium，CDP 驱动）：工具名 browse
  registerBrowserTool(tools);
  registerSpecialistTools(tools, orch, orch.specialists());

  /** 人格解析：这个人专属 ▸ 全局默认 ▸ 内置 */
  const personaFor = (person: { personaId?: string }): PersonaPreset => {
    const c = getConfig();
    const list = withBuiltin(c.personas);
    return list.find((p) => p.id === person.personaId)
      ?? list.find((p) => p.id === c.defaultPersonaId)
      ?? BUILTIN_PERSONA;
  };

  const engine = new ReplyEngine({
    memory,
    tools,
    orch,
    models,
    persist,
    compression: () => getConfig().compression,
    personaFor,
    notice: (text) => push({ at: Date.now(), dir: 'sys', channel: '-', text }),
  });

  const adapters = new AdapterRegistry();
  const drafts = new Map<string, string>();

  const deliver = async (out: Outbound, personId?: string) => {
    push({ at: Date.now(), dir: 'out', channel: out.channel, to: out.to, personId, text: out.text });
    try {
      await adapters.get(out.channel).send(out);
    } catch (err) {
      const m = (err as Error).message;
      push({ at: Date.now(), dir: 'sys', channel: out.channel, personId, text: `[${out.channel}] ❌ 发送失败：${m.slice(0, 200)}` });
      throw err;
    }
  };

  /** 直接给某个通道位置发一条（用于系统通知，如归并验证码） */
  const sendTo = async (channel: string, to: string, text: string) => {
    await deliver({ channel, to, text });
  };

  const inbound = async (msg: Inbound) => {
    // ⚡ 归并验证码：在“发起合并的那个对话”里回 6 位数字 → 自动合并，不再走正常回复
    const codeHit = /^\s*(\d{6})\s*$/.exec(msg.text ?? '');
    if (codeHit) {
      const merged = identity.tryConfirm(codeHit[1], { channel: msg.channel, externalId: msg.externalId });
      if (merged) {
        push({ at: Date.now(), dir: 'in', channel: msg.channel, to: msg.externalId, personId: merged.id, text: msg.text ?? '' });
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: merged.id, text: `[身份] ✔ 归并成功 →「${merged.displayName}」（${merged.id}），现在有 ${merged.bindings.length} 个对话绑定` });
        await deliver({ channel: msg.channel, to: msg.externalId, text: '记住了——这两个对话是你同一个人，以后的记忆我会一起带着。' }, merged.id);
        return;
      }
    }

    const person = identity.resolve(msg.channel, msg.externalId, msg.name);

    // ⌨️ 命令：以 `/` 开头就不再当聊天 —— 不进回复引擎、不进历史、不花 token。
    //    认得的走自己的实现；**不认得的不回复**（只留一条系统日志）。
    const cmd = parseCommand(msg.text ?? '');
    if (cmd) {
      push({ at: Date.now(), dir: 'in', channel: msg.channel, to: msg.externalId, personId: person.id, text: msg.text ?? '' });
      const def = commands.get(cmd.name);
      if (!def) {
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `[命令] /${cmd.name} 不认得（未回复）` });
        return;
      }
      try {
        const r = await def.run({ person, msg, args: cmd.args });
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `[命令] /${cmd.name} → ${r.note}` });
        if (r.reply) await deliver({ channel: msg.channel, to: msg.externalId, text: r.reply }, person.id);
      } catch (err) {
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `[命令] /${cmd.name} 出错：${(err as Error).message}` });
      }
      return; // 无论如何都不进回复引擎
    }

    // 🎤 语音消息：先转文字，然后**直接改写 msg.text** —— 下游整条链路自动当普通文本处理
    const hadVoice = (msg.media ?? []).some((x) => x.kind === 'audio');
    if (!msg.text && hadVoice) {
      const audio = (msg.media ?? []).find((x) => x.kind === 'audio' && x.url);
      const asr = models.asr();
      if (!asr) {
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: '[语音] 收到语音，但没有配 ASR 模型（模型类型要设成 asr）' });
        await deliver({ channel: msg.channel, to: msg.externalId, text: '我这边还没配语音识别，先打字跟我说吧。' }, person.id);
        return;
      }
      const got = audio?.url ? bytesFromDataUrl(audio.url) : undefined;
      if (!got) {
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: '[语音] 音频拿不到或格式认不出' });
        await deliver({ channel: msg.channel, to: msg.externalId, text: '语音我没听清，再说一遍或者打字给我吧。' }, person.id);
        return;
      }
      try {
        const t = await transcribe({
          baseUrl: asr.provider.baseUrl,
          apiKey: asr.provider.apiKey,
          model: asr.model.model,
          audio: got.bytes,
          mime: got.mime,
        });
        msg.text = t;
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `[语音→文字] ${t || '（空）'}  ｜${asr.model.id} ｜${got.bytes.length} 字节` });
      } catch (err) {
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `[语音] 识别失败：${(err as Error).message.slice(0, 160)}` });
        await deliver({ channel: msg.channel, to: msg.externalId, text: '语音识别出问题了，先打字跟我说吧。' }, person.id);
        return;
      }
      if (!msg.text) {
        await deliver({ channel: msg.channel, to: msg.externalId, text: '没听清你说什么，再说一遍？' }, person.id);
        return;
      }
    }

    push({ at: Date.now(), dir: 'in', channel: msg.channel, to: msg.externalId, personId: person.id, text: msg.text ?? '' });

    // ⚠️ 空消息不该进回复引擎：模型收到空 user 输入只会瞎编，
    //    没有媒体又没文本的情况（比如语音下载失败）直接吞掉。
    if (!String(msg.text ?? '').trim() && !(msg.media ?? []).length) return;

    if (queue.isActive(person.id)) {
      if (queue.inject(person.id, msg.text ?? '')) {
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `插话入槽（工具间隙消费）：${msg.text}` });
      }
      return;
    }

    await queue.run(person.id, async (ctx) => {
      const step = (t: string) => push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `[流程] ${t}` });
      step(`开始处理（channel=${msg.channel} to=${msg.externalId}）`);
      try {
        const adapter = adapters.get(msg.channel);
        const target = { channel: msg.channel, to: msg.externalId };

        // 「正在输入」：普通回复也要让对面看到在打字；长任务靠 keepalive 续命
        let typingTimer: NodeJS.Timeout | undefined;
        if (adapter.typing) {
          const kick = () => { void adapter.typing!(target).catch(() => { /* 提示失败不能影响回复 */ }); };
          kick();
          if (adapter.typingKeepaliveMs) typingTimer = setInterval(kick, adapter.typingKeepaliveMs);
          step('已发「正在输入」提示');
        }

        // 流式：仅对主动 opt-in 的通道（如面板/CLI 的 mock）。
        // QQ 默认关闭流式，走一次性发送，稳定优先
        let handle: StreamHandle | undefined;
        if (adapter.supportsStreaming && adapter.openStream) {
          try { handle = await adapter.openStream(target); step('已开流式会话'); } catch { handle = undefined; }
        }

        try {
        const out = await engine.handle(
          person,
          msg,
          ctx,
          handle
            ? {
                onDelta: (full) => {
                  drafts.set(person.id, full);
                  void handle!.update(full);
                },
              }
            : {},
        );
        step(`引擎返回（${out.text.length} 字，to=${out.to}）`);
        drafts.delete(person.id);

        let streamed = false;
        if (handle) {
          try {
            streamed = (await Promise.race([
              handle.end(out.text),
              new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
            ])) === true;
            step(`流式收尾：streamed=${streamed}`);
          } catch (err) {
            step(`流式收尾异常，改用一次性发送：${(err as Error).message.slice(0, 120)}`);
            streamed = false;
          }
        }

        if (!streamed) {
          step('开始投递');
          await deliver(out, person.id);
          step('投递完成');
        }
        } finally {
          if (typingTimer) clearInterval(typingTimer);
        }
      } catch (err) {
        push({ at: Date.now(), dir: 'sys', channel: msg.channel, personId: person.id, text: `[流程] ❌ 异常：${(err as Error).message.slice(0, 200)}` });
        throw err;
      }
    });
  };

  const say = (channel: string, externalId: string, text: string) =>
    inbound({ channel, chatType: 'private', externalId, text, at: Date.now() });

  // ── 定时任务：到点主动投递（say = 直发原话；ask = 触发一轮回复让 agent 自己说）──
  const sched = new Scheduler({
    persist,
    log: (s) => push({ at: Date.now(), dir: 'sys', channel: '定时', text: s }),
    onFire: async (job) => {
      if (job.kind === 'say') {
        await deliver({ channel: job.channel, to: job.to, text: job.text }, job.personId);
        return '已发送';
      }
      await inbound({
        channel: job.channel,
        chatType: 'private',
        externalId: job.to,
        text: `[定时任务] ${job.text}`,
        at: Date.now(),
      });
      return '已触发一轮回复';
    },
    // ⚠️ 任务目标通道可能已经被删/卸载（比如 QQ 通道关了但 job 还留着）：
    //    这里兜住异常，否则会变成 unhandled rejection 把进程带走。
    onError: (job, err) =>
      push({
        at: Date.now(), dir: 'sys', channel: '定时',
        text: `[定时] ${job.id} 执行异常（已隔离，不影响其它任务）：${(err as Error).message}`,
      }),
  });
  registerScheduleTools(tools, sched, identity);
  registerIdentityTools(tools, identity, sendTo);
  // 人格**不**给 agent 任何工具：只能在网页面板里改（三河 2026-10-01 要求）
  // ⌨️ 命令表：`/` 开头的消息走这里，**不进回复引擎**（省 token、也不会让 AI 去“聊”指令）
  const commands = defaultCommands({
    personBindings: (pid) =>
      (identity.all().find((p) => p.id === pid)?.bindings ?? []).map((b) => `${b.channel}:${b.externalId}`),
    status: () => {
      const roles: Record<string, string> = {};
      for (const r of ['reply', 'main', 'sub'] as const) roles[r] = models.resolve(r)?.model.model ?? '未配';
      roles.asr = models.asr()?.model.model ?? '未配';
      return { 模型: roles, 任务总数: orch.all().length, 定时任务: sched.list().length };
    },
    tasks: (pid) => orch.list(pid).map((t) => ({
      id: t.id, kind: t.kind, status: t.status, progress: t.progress, prompt: t.prompt,
    })),
    jobs: (pid) => sched.list()
      .filter((j) => !pid || j.personId === pid)
      .map((j) => ({ id: j.id, title: j.title, spec: j.spec, enabled: j.enabled })),
  });

  sched.start();

  // ── 任务事件：写日志 + 写进对话页时间线 + 结果回注 ─────────
  orch.onEvent((e) => {
    const task = orch.status(e.taskId);

    if (e.kind === 'accepted') return;

    if (e.kind === 'progress') {
      push({ at: Date.now(), dir: 'sys', channel: '-', text: `任务 ${e.taskId} 进度 ${e.progress}%` });
      if (task) engine.note(task.personId, { kind: 'notice', at: Date.now(), text: `[${task.kind}] ${e.text}` });
      return;
    }

    if (e.kind === 'tool') {
      if (task) {
        engine.note(task.personId, {
          kind: 'tool', at: Date.now(), name: `${task.kind}:${e.name}`,
          args: e.args ?? '{}', result: e.result ?? '', ms: 0,
          ...(e.isError ? { error: true } : {}),
        });
      }
      return;
    }

    // done → 回注到来源通道
    if (!task) return;
    const person = identity.all().find((p) => p.id === task.personId);
    const originKnown = person?.bindings.find((b) => b.channel === task.origin.channel);
    const target = originKnown?.channel ?? person?.preferredChannel ?? task.origin.channel;
    const to = person?.bindings.find((b) => b.channel === target)?.externalId ?? task.origin.externalId;
    void deliver({ channel: target, to, text: `（任务回注·${task.kind}）${e.text}` }, task.personId);
  });

  // ⭐ 真实通道必须**先注册**：否则会被同名 mock 占位遮住，
  //    后果是入站正常、出站却被 mock 静默吞掉（这个坑真踩过）
  const qqCfg = getConfig().qq;
  let qq: QQAdapter | undefined;
  if (qqCfg?.appId && qqCfg?.clientSecret) {
    qq = new QQAdapter(
      {
        appId: qqCfg.appId,
        clientSecret: qqCfg.clientSecret,
        ...(qqCfg.minChars != null ? { minChars: qqCfg.minChars } : {}),
        ...(qqCfg.idleMs != null ? { idleMs: qqCfg.idleMs } : {}),
        ...(qqCfg.useStreaming != null ? { useStreaming: qqCfg.useStreaming } : {}),
        ...(qqCfg.gateway != null ? { gateway: qqCfg.gateway } : {}),
      },
      (s) => push({ at: Date.now(), dir: 'sys', channel: 'qq', text: s }),
    );
    adapters.add(qq);
    void qq.start(inbound);
  }

  // Telegram：长轮询收消息，支持真流式（编辑同一条消息）+ 「正在输入」
  const tgCfg = getConfig().telegram;
  let telegram: TelegramAdapter | undefined;
  if (tgCfg?.token) {
    telegram = new TelegramAdapter(
      {
        token: tgCfg.token,
        ...(tgCfg.pollSeconds != null ? { pollSeconds: tgCfg.pollSeconds } : {}),
        ...(tgCfg.allowFrom ? { allowFrom: tgCfg.allowFrom } : {}),
        ...(tgCfg.streaming != null ? { streaming: tgCfg.streaming } : {}),
      },
      (s) => push({ at: Date.now(), dir: 'sys', channel: 'telegram', text: s }),
    );
    adapters.add(telegram);
    void telegram.start(inbound);
  }

  for (const id of opts.channels ?? DEFAULT_CHANNELS) {
    if (adapters.has(id)) {
      push({ at: Date.now(), dir: 'sys', channel: id, text: `通道 ${id} 已被真实适配器接管，跳过 mock 占位` });
      continue;
    }
    const mock = new MockAdapter(id, { silent: true });
    adapters.add(mock);
    void mock.start(inbound);
  }

  return {
    identity, memory, queue, orch, tools, models, engine, adapters, log, drafts, persist, sched, mcp,
    ...(qq ? { qq } : {}),
    ...(telegram ? { telegram } : {}),
    onLog: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    inbound, say, sendTo,
  };
}
