import { join } from 'node:path';
import type { Harness } from '../harness/types.ts';
import type { Task, TaskEvent, TaskRunner } from './types.ts';

export interface SpecialistModel {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/**
 * 两类子 agent 里的「专员」定义。
 *
 * tools 是**能力边界** —— 前台看得见它、主 agent 也能调它，但能干什么由这张白名单锁死。
 */
export interface Specialist {
  kind: string;
  label: string;
  /** 写给前台的边界描述：决定快模型什么时候该调它、什么时候不该 */
  description: string;
  tools?: string[];
  systemPrompt?: string;
  /**
   * 长线专员标记：**只有带这个的才会留会话、分段推进**。
   * 其余专员一律保持一次性（--no-session）—— 隔离性不变。
   */
  long?: { segments: number; segmentTimeoutMs: number };
}

export const defaultSpecialists = (): Specialist[] => [
  {
    kind: 'browser',
    label: '浏览器专员',
    description: '需要打开具体网页、点击、截图、抓页面内容时用。单纯查资料不要用这个，用 deep_search。',
    // ⚠️ 2026-10-02：以前这里只有 read/write/edit/bash/grep/find/ls —— **没有任何浏览器能力**，
    //    "打开网页"其实只是 curl 静态 HTML，不会渲染 JS、不能点击、不能截图。
    //    现在接上了真工具 browse（无头 Chromium），并且这个专员改跑 local harness
    //    （pi harness 看不到本项目自己的工具）。
    tools: ['browse', 'read', 'ls', 'grep', 'find'],
    systemPrompt:
      '你是浏览器/取数专员：用 browse 工具真开浏览器。\n'
      + '步骤：browse action=open 打开网址 → action=text 取正文，或 action=snapshot 看可点元素 → action=click 点进去 → '
      + '需要证据就 action=screenshot 截图。\n'
      + '页面靠 JS 渲染、需要翻页/点击/登录态的，都必须用 browse，**不要用 curl**（拿不到渲染后的内容）。\n'
      + '取回关键信息后简明汇报，带上来源网址。',
  },
  {
    kind: 'deep_search',
    label: '深度搜索专员',
    description: '需要多轮检索、交叉验证、做调研、要"查全一点"时用。单次查询不要用这个，用 search。',
    tools: ['search'],
    systemPrompt: '你是深度搜索专员：用 search 工具多轮检索、交叉验证，最后给出带来源的结论。至少搜两轮不同角度。',
  },
  {
    kind: 'long_task',
    label: '长任务专员',
    description:
      '任务很大、估计跑很久、或中途可能断掉需要接着做时用（如「把整个项目审一遍」「逐文件重构」）。'
      + '它是唯一会保留会话的专员，所以能跨段续跑；普通单一任务不要用它（更慢也更贵）。',
    // ⚠️ 这个专员跑在 **pi harness** 上，只能用 pi 自己的工具（read/bash/edit/write 系）。
    //    以前这里列了 'search'（我们的秘塔工具）—— pi 根本看不到，等于白列。去掉，保持白名单诚实。
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
    systemPrompt:
      '你是长任务专员：任务可能很大，会被拆成多段、每段接着上一段继续（会话里有之前的上下文）。\n'
      + '每段开始先看上次做到哪了，然后**继续推进**，做完一部分就落盘，不要重复已完成的。\n'
      + '全部做完后，回复里必须包含「全部完成」四个字，以便停下。',
    long: { segments: 3, segmentTimeoutMs: 600_000 },
  },
];

/** 第一类：通用 worker 的系统提示（不暴露给前台，只由 delegate 触发） */
export const GENERAL_PROMPT =
  '你是一个通用执行者：可以读写文件、跑命令、查资料。把任务做完，然后用简洁中文汇报结果和关键发现。不要寒暄。';

/**
 * 把 harness 包成 TaskRunner：harness 的事件 → 任务进度/工具事件 → 结果。
 */
export function makeRunner(opts: {
  harness: Harness;
  model: () => SpecialistModel | undefined;
  workspace: string;
  tools?: string[];
  systemPrompt?: string;
  timeoutMs?: number;
  /** 该 harness 跑不了时用的兜底（通常是 local） */
  fallback?: Harness;
  /**
   * 长线模式：同一会话分段推进，直到模型说「全部完成」或段数用尽。
   * 只有长任务专员会传这个；不传就是原来的一次性行为。
   */
  longRun?: { segments: number; segmentTimeoutMs: number };
}): TaskRunner {
  return (task: Task, emit: (e: TaskEvent) => void) => {
    const model = opts.model();
    if (!model) {
      emit({ taskId: task.id, kind: 'done', text: '没有可用的子 agent 模型（面板里没给 main / sub 配模型）' });
      return;
    }

    const cwd = join(opts.workspace, task.id);
    /** 长线专员：每个任务一个稳定会话（任务 id 派生），所以能跨段接着跑 */
    const session = opts.longRun ? 'friend-task-' + task.id : undefined;
    let progress = 5;
    emit({ taskId: task.id, kind: 'progress', progress, text: '启动子 agent' });

    const onEvent = (e: Parameters<Parameters<Harness['run']>[0]['onEvent']>[0]): void => {
      if (e.type === 'tool') {
        if (e.phase === 'start') {
          emit({
            taskId: task.id, kind: 'tool', name: e.name,
            args: typeof e.args === 'string' ? e.args : JSON.stringify(e.args ?? {}),
          });
          progress = Math.min(90, progress + 8);
          emit({ taskId: task.id, kind: 'progress', progress, text: `调用 ${e.name}` });
        } else {
          emit({ taskId: task.id, kind: 'tool', name: e.name, result: e.result, isError: e.isError });
        }
      } else if (e.type === 'notice') {
        emit({ taskId: task.id, kind: 'progress', progress, text: e.text });
      } else if (e.type === 'error') {
        emit({ taskId: task.id, kind: 'tool', name: 'error', result: e.message, isError: true });
      }
    };

    const runOn = (h: Harness, prompt: string, timeoutMs?: number) =>
      h.run({
        prompt,
        model,
        cwd,
        tools: opts.tools,
        systemPrompt: opts.systemPrompt,
        ctx: { personId: task.personId, taskId: task.id },
        onEvent,
        timeoutMs: timeoutMs ?? opts.timeoutMs,
        ...(session ? { session } : {}),
      });

    // ── 一次性（默认）：绝大多数专员走这里，行为不变 ──
    if (!opts.longRun) {
      runOn(opts.harness, task.prompt)
        .catch(async (err) => {
          if (!opts.fallback) throw err;
          emit({ taskId: task.id, kind: 'progress', progress, text: `主 harness 失败，回退 local：${(err as Error).message}` });
          return runOn(opts.fallback, task.prompt);
        })
        .then((r) => emit({ taskId: task.id, kind: 'done', text: r.text || '（没有产出）' }))
        .catch((err) => emit({ taskId: task.id, kind: 'done', text: `子 agent 失败：${(err as Error).message}` }));
      return;
    }

    // ── 长线：同一 session 分段推进 ──
    void (async () => {
      const { segments, segmentTimeoutMs } = opts.longRun!;
      let lastText = '';
      for (let i = 1; i <= segments; i += 1) {
        const prompt = i === 1
          ? task.prompt
          : '继续上次没做完的部分（会话里有前面的上下文）。'
            + '如果已经全部完成，只回复「全部完成」四个字，不要再动别的。';
        emit({
          taskId: task.id, kind: 'progress', progress: Math.min(92, progress + 4),
          text: `长任务第 ${i}/${segments} 段（会话 ${session}）`,
        });
        try {
          const r = await runOn(opts.harness, prompt, segmentTimeoutMs);
          if (r.text) lastText = r.text;
          if (/全部完成/.test(r.text || '')) {
            emit({ taskId: task.id, kind: 'done', text: `长任务在第 ${i} 段完成\n${lastText}` });
            return;
          }
        } catch (err) {
          emit({ taskId: task.id, kind: 'progress', progress, text: `第 ${i} 段出错：${(err as Error).message}` });
        }
      }
      emit({
        taskId: task.id, kind: 'done',
        text: `${segments} 段跑完但没收到「全部完成」（会话已保留，可再派一次接着做）\n${lastText || '（没有产出）'}`,
      });
    })();
  };
}
