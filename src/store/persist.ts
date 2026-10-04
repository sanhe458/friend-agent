import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Person } from '../core/types.ts';
import type { MemoryItem } from '../memory/store.ts';
import type { ChatMessage } from '../models/client.ts';
import type { Task } from '../orchestrator/types.ts';

/** 一条持久化的事件（TurnEvent 原样存 JSON） */
export interface StoredEvent { personId: string; at: number; kind: string; data: string }

/**
 * 一条定时任务。
 * - spec 是“规则文本”，**下次触发时间 nextAt 由调度器算好后写回**，不在 spec 里。
 * - kind: say = 到点把 text 原样发出；ask = 把 text 当作提示词跑一轮 agent，由它自己组织语言。
 */
export interface JobRecord {
  id: string;
  title: string;
  spec: string;
  kind: 'say' | 'ask';
  text: string;
  channel: string;
  to: string;
  personId?: string;
  enabled: boolean;
  createdAt: number;
  nextAt: number;
  lastRunAt?: number;
  runs: number;
  lastResult?: string;
}

export interface Persistence {
  enabled: boolean;
  loadPersons(): Person[];
  savePerson(p: Person): void;
  deletePerson(id: string): void;

  loadMemories(): Array<{ personId: string; item: MemoryItem }>;
  /** 落一条记忆，返回库里的自增 id（后台补算向量时用它 UPDATE） */
  saveMemory(personId: string, item: MemoryItem): number;
  /** 记忆的嵌入向量算好后补写（换模型重算也走这里） */
  saveMemoryVec(id: number, vec: Float32Array, model: string): void;

  loadHistory(personId: string, limit?: number): ChatMessage[];
  saveHistory(personId: string, msg: ChatMessage): void;
  /** 这个人历史里最后一条消息的时间（没有历史 = undefined）；每日翻篇用它恢复「当前属于哪天」 */
  lastHistoryAt(personId: string): number | undefined;
  /** 清空这个人的历史（每日翻篇：旧上下文归档后从活跃区清走，见 src/context/daily.ts） */
  clearHistory(personId: string): void;

  loadEvents(personId: string, limit?: number): Array<Record<string, unknown>>;
  saveEvent(personId: string, ev: Record<string, unknown>): void;

  loadTasks(): Task[];
  saveTask(t: Task): void;

  loadJobs(): JobRecord[];
  saveJob(j: JobRecord): void;
  deleteJob(id: string): void;

  close(): void;
}

const SCHEMA = `
create table if not exists persons (
  id text primary key,
  display_name text not null,
  preferred_channel text,
  persona_id text,
  created_at integer not null
);
create table if not exists bindings (
  channel text not null,
  external_id text not null,
  person_id text not null,
  verified_at integer,
  display_name text,
  primary key (channel, external_id)
);
create index if not exists idx_bindings_person on bindings(person_id);
create table if not exists memories (
  id integer primary key autoincrement,
  person_id text not null,
  text text not null,
  tags text not null default '',
  channel text not null default '',
  at integer not null,
  hot integer not null default 1,
  vec blob,
  vec_model text
);
create index if not exists idx_memories_person on memories(person_id, id);
create table if not exists history (
  id integer primary key autoincrement,
  person_id text not null,
  role text not null,
  content text not null,
  tool_calls text,
  at integer not null
);
create index if not exists idx_history_person on history(person_id, id);
create table if not exists events (
  id integer primary key autoincrement,
  person_id text not null,
  at integer not null,
  kind text not null,
  data text not null
);
create index if not exists idx_events_person on events(person_id, id);
create table if not exists tasks (
  id text primary key,
  person_id text not null,
  kind text not null,
  prompt text not null,
  status text not null,
  progress integer not null default 0,
  result text,
  origin text not null,
  created_at integer not null
);
create table if not exists jobs (
  id text primary key,
  title text not null,
  spec text not null,
  kind text not null,
  text text not null,
  channel text not null,
  to_id text not null,
  person_id text,
  enabled integer not null default 1,
  created_at integer not null,
  next_at integer not null,
  last_run_at integer,
  runs integer not null default 0,
  last_result text
);
create index if not exists idx_jobs_next on jobs(enabled, next_at);
`;

export function createNullPersistence(): Persistence {
  return {
    enabled: false,
    loadPersons: () => [],
    savePerson: () => {},
    deletePerson: () => {},
    loadMemories: () => [],
    saveMemory: () => 0,
    saveMemoryVec: () => {},
    loadHistory: () => [],
    saveHistory: () => {},
    lastHistoryAt: () => undefined,
    clearHistory: () => {},
    loadEvents: () => [],
    saveEvent: () => {},
    loadTasks: () => [],
    saveTask: () => {},
    loadJobs: () => [],
    saveJob: () => {},
    deleteJob: () => {},
    close: () => {},
  };
}

/** 用 Node 内置的 node:sqlite，不引第三方依赖 */
export function createSqlitePersistence(file: string): Persistence {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // 轻量迁移：老库的 persons 没有 persona_id 列（已存在时报错，忽略）
  try { db.exec('alter table persons add column persona_id text'); } catch { /* 已有 */ }
  // 轻量迁移：老库的 memories 没有向量列（记忆语义召回，2026-10-03）
  try { db.exec('alter table memories add column vec blob'); } catch { /* 已有 */ }
  try { db.exec('alter table memories add column vec_model text'); } catch { /* 已有 */ }

  const q = {
    upsertPerson: db.prepare(
      `insert into persons (id, display_name, preferred_channel, persona_id, created_at) values (?, ?, ?, ?, ?)
       on conflict(id) do update set display_name=excluded.display_name, preferred_channel=excluded.preferred_channel, persona_id=excluded.persona_id`,
    ),
    delPerson: db.prepare('delete from persons where id = ?'),
    delPersonCascade: db.prepare('delete from memories where person_id = ?'),
    delPersonHist: db.prepare('delete from history where person_id = ?'),
    delPersonEvts: db.prepare('delete from events where person_id = ?'),
    delBindings: db.prepare('delete from bindings where person_id = ?'),
    insBinding: db.prepare(
      `insert into bindings (channel, external_id, person_id, verified_at, display_name) values (?, ?, ?, ?, ?)
       on conflict(channel, external_id) do update set person_id=excluded.person_id, verified_at=excluded.verified_at`,
    ),
    // 修剪：每张表只保留每人最近 N 条。**以前只 INSERT 从不 DELETE** ——
    // 内存里有上限，数据库没有；跑几个月 events（每个工具调用一条）会堆到几十万行。
    //
    // 修剪语义：保留最近 KEEP 条。子查询取「倒数第 KEEP 条」的 id，
    // 删除条件用 `id <= 它`（把那一条也删掉）→ 正好剩 KEEP 条。
    // ⚠️ 2026-10-03 复核：62002b7 把它改成 `id <`，实测稳定剩 KEEP+1 条（off-by-one 反向了），已改回。
    pruneHist: db.prepare(
      'delete from history where person_id = ? and id <= (select id from history where person_id = ? order by id desc limit 1 offset ?)',
    ),
    pruneEvts: db.prepare(
      'delete from events where person_id = ? and id <= (select id from events where person_id = ? order by id desc limit 1 offset ?)',
    ),
    allPersons: db.prepare('select id, display_name, preferred_channel, persona_id, created_at from persons'),
    allBindings: db.prepare('select channel, external_id, person_id, verified_at, display_name from bindings'),

    allMemories: db.prepare('select id, person_id, text, tags, channel, at, hot, vec, vec_model from memories order by id'),
    insMemory: db.prepare(
      'insert into memories (person_id, text, tags, channel, at, hot) values (?, ?, ?, ?, ?, ?)',
    ),
    updMemoryVec: db.prepare('update memories set vec = ?, vec_model = ? where id = ?'),

    hist: db.prepare(
      'select role, content, tool_calls, at from history where person_id = ? order by id desc limit ?',
    ),
    insHist: db.prepare(
      'insert into history (person_id, role, content, tool_calls, at) values (?, ?, ?, ?, ?)',
    ),
    lastHistAt: db.prepare('select at from history where person_id = ? order by id desc limit 1'),
    clearHist: db.prepare('delete from history where person_id = ?'),

    evts: db.prepare('select at, kind, data from events where person_id = ? order by id desc limit ?'),
    insEvt: db.prepare('insert into events (person_id, at, kind, data) values (?, ?, ?, ?)',),

    allTasks: db.prepare(
      'select id, person_id, kind, prompt, status, progress, result, origin, created_at from tasks order by created_at',
    ),
    upsertTask: db.prepare(
      `insert into tasks (id, person_id, kind, prompt, status, progress, result, origin, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set status=excluded.status, progress=excluded.progress, result=excluded.result`,
    ),

    allJobs: db.prepare(
      'select id, title, spec, kind, text, channel, to_id, person_id, enabled, created_at, next_at, last_run_at, runs, last_result from jobs order by next_at',
    ),
    upsertJob: db.prepare(
      `insert into jobs (id, title, spec, kind, text, channel, to_id, person_id, enabled, created_at, next_at, last_run_at, runs, last_result)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set title=excluded.title, spec=excluded.spec, kind=excluded.kind,
         text=excluded.text, channel=excluded.channel, to_id=excluded.to_id, person_id=excluded.person_id,
         enabled=excluded.enabled, next_at=excluded.next_at, last_run_at=excluded.last_run_at,
         runs=excluded.runs, last_result=excluded.last_result`,
    ),
    delJob: db.prepare('delete from jobs where id = ?'),
  };

  // 每人保留多少条（内存里分别是 60 / 400，库里给宽松一点）
  const KEEP_HISTORY = 400;
  const KEEP_EVENTS = 1200;
  /** 每存 N 条修剪一次：不必要每条都跑 DELETE */
  const PRUNE_EVERY = 25;
  let sinceHistPrune = 0;
  let sinceEvtPrune = 0;

  return {
    enabled: true,

    loadPersons(): Person[] {
      const byId = new Map<string, Person>();
      for (const r of q.allPersons.all() as any[]) {
        byId.set(String(r.id), {
          id: String(r.id),
          displayName: String(r.display_name),
          bindings: [],
          ...(r.preferred_channel ? { preferredChannel: String(r.preferred_channel) } : {}),
          ...(r.persona_id ? { personaId: String(r.persona_id) } : {}),
          createdAt: Number(r.created_at),
        });
      }
      for (const b of q.allBindings.all() as any[]) {
        const p = byId.get(String(b.person_id));
        if (!p) continue;
        p.bindings.push({
          channel: String(b.channel),
          externalId: String(b.external_id),
          ...(b.verified_at != null ? { verifiedAt: Number(b.verified_at) } : {}),
          ...(b.display_name ? { displayName: String(b.display_name) } : {}),
        });
      }
      return [...byId.values()];
    },

    savePerson(p: Person): void {
      q.upsertPerson.run(p.id, p.displayName, p.preferredChannel ?? null, p.personaId ?? null, p.createdAt);
      // ⚠️ 以前只 upsert、不删多余的绑定。合并时把某个绑定从这个人身上移走后，
      //    库里那行还指着旧 person_id → **重启后 loadPersons 会把它加回来**，等于合并部分回滚。
      //    改成「先删这个人的全部绑定，再按内存里的状态重插」。
      q.delBindings.run(p.id);
      for (const b of p.bindings) {
        q.insBinding.run(b.channel, b.externalId, p.id, b.verifiedAt ?? null, b.displayName ?? null);
      }
    },

    deletePerson(id: string): void {
      q.delBindings.run(id);
      q.delPerson.run(id);
      // 连带清掉这个人的数据，别留孤儿行
      q.delPersonCascade.run(id);
      q.delPersonHist.run(id);
      q.delPersonEvts.run(id);
    },

    loadMemories(): Array<{ personId: string; item: MemoryItem }> {
      return (q.allMemories.all() as any[]).map((r) => {
        // 向量列：BLOB → Float32Array。
        // ⚠️ node:sqlite 读出的 BLOB 是 Uint8Array（有的版本是 Buffer，它是 Uint8Array 的子类）
        //    ——只认 Buffer 的话向量永远恢复不出来，重开后全量退回关键词（实测踩过）。
        let vec: Float32Array | undefined;
        if (r.vec instanceof Uint8Array && r.vec.byteLength >= 4) {
          try {
            const copy = new Uint8Array(r.vec.byteLength);
            copy.set(r.vec);
            vec = new Float32Array(copy.buffer);
          } catch { vec = undefined; }
        }
        return {
          personId: String(r.person_id),
          item: {
            id: Number(r.id),
            text: String(r.text),
            tags: String(r.tags ?? '').split(',').filter(Boolean),
            channel: String(r.channel ?? ''),
            at: Number(r.at),
            hot: Number(r.hot) === 1,
            ...(vec ? { vec } : {}),
            ...(r.vec_model ? { vecModel: String(r.vec_model) } : {}),
          } as MemoryItem,
        };
      });
    },

    saveMemory(personId: string, item: MemoryItem): number {
      const r = q.insMemory.run(personId, item.text, item.tags.join(','), item.channel, item.at, item.hot ? 1 : 0);
      return Number(r.lastInsertRowid);
    },

    saveMemoryVec(id: number, vec: Float32Array, model: string): void {
      // Float32Array → Buffer（拷贝一份，别共享底层 buffer）
      const blob = Buffer.from(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
      q.updMemoryVec.run(blob, model, id);
    },

    loadHistory(personId: string, limit = 60): ChatMessage[] {
      const rows = q.hist.all(personId, limit) as any[];
      return rows.reverse().map((r) => {
        const msg: ChatMessage = { role: String(r.role) as ChatMessage['role'], content: String(r.content ?? '') };
        if (r.tool_calls) {
          try { msg.tool_calls = JSON.parse(String(r.tool_calls)); } catch { /* ignore */ }
        }
        return msg;
      });
    },

    saveHistory(personId: string, msg: ChatMessage): void {
      q.insHist.run(
        personId, msg.role, msg.content ?? '',
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null, Date.now(),
      );
      if (++sinceHistPrune >= PRUNE_EVERY) {
        sinceHistPrune = 0;
        try { q.pruneHist.run(personId, personId, KEEP_HISTORY); } catch { /* 修剪失败不影响写入 */ }
      }
    },

    lastHistoryAt(personId: string): number | undefined {
      const r = q.lastHistAt.get(personId) as { at: number | bigint } | undefined;
      return r ? Number(r.at) : undefined;
    },

    clearHistory(personId: string): void {
      q.clearHist.run(personId);
    },

    loadEvents(personId: string, limit = 200): Array<Record<string, unknown>> {
      const rows = q.evts.all(personId, limit) as any[];
      return rows.reverse().map((r) => {
        try { return JSON.parse(String(r.data)) as Record<string, unknown>; }
        catch { return { kind: String(r.kind), at: Number(r.at), text: String(r.data ?? '') }; }
      });
    },

    saveEvent(personId: string, ev: Record<string, unknown>): void {
      q.insEvt.run(personId, Number(ev.at ?? Date.now()), String(ev.kind ?? '?'), JSON.stringify(ev));
      if (++sinceEvtPrune >= PRUNE_EVERY) {
        sinceEvtPrune = 0;
        try { q.pruneEvts.run(personId, personId, KEEP_EVENTS); } catch { /* 同上 */ }
      }
    },

    loadTasks(): Task[] {
      return (q.allTasks.all() as any[]).map((r) => {
        // origin 是 JSON；坏一行不该让整个加载炸掉
        let origin: Task['origin'] = { personId: '', channel: '', externalId: '' };
        try { origin = JSON.parse(String(r.origin)); } catch { /* 用兜底 */ }
        return {
          id: String(r.id),
          personId: String(r.person_id),
          kind: String(r.kind),
          prompt: String(r.prompt),
          status: String(r.status) as Task['status'],
          progress: Number(r.progress),
          ...(r.result != null ? { result: String(r.result) } : {}),
          origin,
          createdAt: Number(r.created_at),
        };
      });
    },

    saveTask(t: Task): void {
      q.upsertTask.run(
        t.id, t.personId, t.kind, t.prompt, t.status, t.progress,
        t.result ?? null, JSON.stringify(t.origin), t.createdAt,
      );
    },

    loadJobs(): JobRecord[] {
      return (q.allJobs.all() as any[]).map((r) => ({
        id: String(r.id),
        title: String(r.title),
        spec: String(r.spec),
        kind: String(r.kind) === 'ask' ? 'ask' : 'say',
        text: String(r.text),
        channel: String(r.channel),
        to: String(r.to_id),
        ...(r.person_id != null ? { personId: String(r.person_id) } : {}),
        enabled: Number(r.enabled) === 1,
        createdAt: Number(r.created_at),
        nextAt: Number(r.next_at),
        ...(r.last_run_at != null ? { lastRunAt: Number(r.last_run_at) } : {}),
        runs: Number(r.runs),
        ...(r.last_result != null ? { lastResult: String(r.last_result) } : {}),
      } as JobRecord));
    },

    saveJob(j: JobRecord): void {
      q.upsertJob.run(
        j.id, j.title, j.spec, j.kind, j.text, j.channel, j.to, j.personId ?? null,
        j.enabled ? 1 : 0, j.createdAt, j.nextAt, j.lastRunAt ?? null, j.runs, j.lastResult ?? null,
      );
    },

    deleteJob(id: string): void { q.delJob.run(id); },

    close(): void { db.close(); },
  };
}
