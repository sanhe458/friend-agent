import type { Persistence } from '../store/persist.ts';
import type { Task, TaskEvent, TaskRunner } from './types.ts';

/**
 * 调度：模型分配是策略层（不是 LLM）。
 *
 * - `kind: 'general'` → 通用 worker（前台不可见，只能由 delegate 触发）
 * - 其余 kind → 专员（前台可直接调，主 agent 也能调，走同一注册表）
 *
 * 具体怎么跑交给注入的 TaskRunner（背后是 Pi / 进程内 harness / 假实现）。
 */
export class Orchestrator {
  #tasks = new Map<string, Task>();
  #handlers = new Set<(e: TaskEvent) => void>();
  #runners = new Map<string, TaskRunner>();
  #fallback?: TaskRunner;
  #specialists: { kind: string; label: string; description: string }[] = [];
  #persist?: Persistence;

  constructor(opts: {
    runners?: Record<string, TaskRunner>;
    fallback?: TaskRunner;
    specialists?: { kind: string; label: string; description: string }[];
    persist?: Persistence;
  } = {}) {
    for (const [k, v] of Object.entries(opts.runners ?? {})) this.#runners.set(k, v);
    this.#fallback = opts.fallback;
    this.#specialists = opts.specialists ?? [];
    this.#persist = opts.persist;
    if (opts.persist?.enabled) {
      for (const t of opts.persist.loadTasks()) {
        // 上次进程死掉的 running 任务标成失败，避免永远“在跑”
        if (t.status === 'running') t.status = 'failed';
        this.#tasks.set(t.id, t);
      }
      // ⚠️ 原来是：算出一个 max 然后 `void max;` —— 死代码，且那行 Number(base36) 解析本身就是错的。
      //    真正的需求是「重启后新 id 不能撞已恢复的旧 id」。已改成基于时间戳生成 id（见 dispatch），
      //    不依赖任何序号恢复，重启也不会覆盖旧任务。
    }
  }

  registerRunner(kind: string, runner: TaskRunner): void { this.#runners.set(kind, runner); }

  registerSpecialist(s: { kind: string; label: string; description: string }): void {
    this.#specialists = this.#specialists.filter((x) => x.kind !== s.kind).concat(s);
  }

  specialists(): { kind: string; label: string; description: string }[] { return [...this.#specialists]; }

  onEvent(h: (e: TaskEvent) => void): () => void {
    this.#handlers.add(h);
    return () => { this.#handlers.delete(h); };
  }

  #emit(e: TaskEvent): void {
    for (const h of this.#handlers) {
      try { h(e); } catch (err) { console.error('[orchestrator]', err); }
    }
  }

  dispatch(input: {
    personId: string;
    origin: { personId: string; channel: string; externalId: string };
    prompt: string;
    kind?: string;
  }): { taskId: string; kind: string } {
    const kind = input.kind ?? 'general';
    // id 带时间戳（base36）+ 随机后缀：**重启后也不会撞上已恢复的旧 id**（以前靠 #seq，重启归零就有撞车风险）
    const id = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

    const task: Task = {
      id,
      personId: input.personId,
      origin: input.origin,
      prompt: input.prompt,
      kind,
      status: 'running',
      progress: 0,
      createdAt: Date.now(),
    };
    this.#tasks.set(id, task);
    this.#persist?.saveTask(task);
    this.#emit({ taskId: id, kind: 'accepted' });

    const runner = this.#runners.get(kind) ?? this.#fallback;

    queueMicrotask(() => {
      if (!runner) {
        task.status = 'done';
        task.progress = 100;
        task.result = '没有可用的执行者（既没有子 agent 模型，也没有兜底 runner）';
        this.#emit({ taskId: id, kind: 'done', text: task.result });
        return;
      }
      try {
        // ⚠️ runner 返回 Promise —— 不接住的话，外面这个 try/catch **抓不到异步抛错**（会变成 unhandled rejection）
        void Promise.resolve(runner(task, (e) => {
          if (e.kind === 'progress') { task.progress = e.progress; this.#persist?.saveTask(task); }
          if (e.kind === 'done') {
            task.status = 'done'; task.progress = 100; task.result = e.text;
            this.#persist?.saveTask(task);
          }
          this.#emit(e);
        })).catch((err) => {
          task.status = 'failed';
          this.#emit({ taskId: id, kind: 'done', text: `执行器抛错：${(err as Error).message}` });
        });
      } catch (err) {
        // 同步抛错（runner 里的逻辑在调用时就炸了）
        task.status = 'failed';
        const text = `执行器抛错：${(err as Error).message}`;
        this.#emit({ taskId: id, kind: 'done', text });
      }
    });

    return { taskId: id, kind };
  }

  status(taskId: string): Task | undefined { return this.#tasks.get(taskId); }
  list(personId: string): Task[] { return [...this.#tasks.values()].filter((t) => t.personId === personId); }
  all(): Task[] { return [...this.#tasks.values()]; }
}
