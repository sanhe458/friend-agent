import type { Capabilities, Inbound, Outbound } from '../core/types.ts';

/**
 * 流式会话句柄。
 * `update()` 收到的是**累计全文**（不是增量）—— 因为 QQ 流式是 replace 语义，
 * 每条帧都替换上一条；各通道内部自己决定怎么节流、怎么落地。
 */
export interface StreamHandle {
  /** 更新到「当前全文」 */
  update(fullText: string): Promise<void>;
  /** 收尾。**返回 true = 已经通过流式送达，调用方无需再发一次** */
  end(finalText: string): Promise<boolean>;
  /** 提前放弃（例如中途失败），不抛错 */
  abort?(reason?: string): Promise<void>;
}

export interface Adapter {
  id: string;
  /** 通道性质：mock = 本地假通道（不发真网络请求）。不写 = 真实通道 */
  kind?: 'real' | 'mock';
  /** 通道能力：回复生成时必须感知（长度上限 / 支持的媒体 / 能否流式） */
  capabilities: Capabilities;
  start(emit: (m: Inbound) => void): Promise<void>;
  send(out: Outbound): Promise<void>;
  stop?(): Promise<void>;

  /** 是否支持"正在输入"提示 */
  typing?(out: Omit<Outbound, 'text'>): Promise<void>;
  /** 提示保持时间：到了就重发（QQ 的窗口约 60s） */
  typingKeepaliveMs?: number;

  /** 是否支持"边说边显示" */
  supportsStreaming?: boolean;
  /** 开一个流式会话；不支持就返回 undefined，调用方退回一次性 send */
  openStream?(out: Omit<Outbound, 'text'>): Promise<StreamHandle | undefined>;
}

export class AdapterRegistry {
  #map = new Map<string, Adapter>();

  add(adapter: Adapter): void {
    if (this.#map.has(adapter.id)) throw new Error(`通道重名: ${adapter.id}`);
    this.#map.set(adapter.id, adapter);
  }
  get(id: string): Adapter {
    const a = this.#map.get(id);
    if (!a) throw new Error(`未知通道: ${id}`);
    return a;
  }
  has(id: string): boolean { return this.#map.has(id); }
  all(): Adapter[] { return [...this.#map.values()]; }
}
