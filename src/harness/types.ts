export type HarnessEvent =
  | { type: 'start' }
  | { type: 'notice'; text: string }
  | { type: 'tool'; phase: 'start' | 'end'; name: string; args?: unknown; result?: string; isError?: boolean }
  | { type: 'error'; message: string };

export interface HarnessModel {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface HarnessRunOpts {
  prompt: string;
  model: HarnessModel;
  /** 子 agent 的工作目录（工作区沙箱就靠它） */
  cwd: string;
  /** 该专员的工具白名单 */
  tools?: string[];
  systemPrompt?: string;
  ctx: { personId: string; taskId: string };
  onEvent: (e: HarnessEvent) => void;
  timeoutMs?: number;
  /**
   * 会话 id。
   * - 不传：一次性（默认）—— 不留痕迹、跑完即焚，适合绝大多数专员
   * - 传了：用固定会话，**可续跑**（长任务专员用这个）：中途挂了能接着上次继续
   */
  session?: string;
}

export interface Harness {
  id: string;
  available(): Promise<boolean>;
  run(opts: HarnessRunOpts): Promise<{ text: string }>;
}

/** 从各家五花八门的 content 结构里抠出纯文本 */
export function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n');
  const o = v as Record<string, unknown>;
  if (typeof o.text === 'string') return o.text;
  if (o.content != null) return textOf(o.content);
  if (typeof o.output === 'string') return o.output;
  return '';
}
