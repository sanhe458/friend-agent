export interface TaskOrigin {
  personId: string;
  channel: string;
  externalId: string;
}

export type TaskKind = string; // 'general' | 'browser' | 'deep_search' | ...

export interface Task {
  id: string;
  personId: string;
  origin: TaskOrigin;
  prompt: string;
  kind: TaskKind;
  status: 'running' | 'done' | 'failed';
  progress: number;
  result?: string;
  createdAt: number;
}

export type TaskEvent =
  | { taskId: string; kind: 'accepted' }
  | { taskId: string; kind: 'progress'; progress: number; text: string }
  | { taskId: string; kind: 'tool'; name: string; args?: string; result?: string; isError?: boolean }
  | { taskId: string; kind: 'done'; text: string };

export type TaskRunner = (task: Task, emit: (e: TaskEvent) => void) => void;
