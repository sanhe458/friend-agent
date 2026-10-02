import type { Capabilities, Inbound, Outbound } from '../core/types.ts';
import type { Adapter, StreamHandle } from './adapter.ts';

/** M1 用的假通道：不发真网络请求，把发出的消息打到 outbox / 控制台 */
export class MockAdapter implements Adapter {
  id: string;
  kind = 'mock' as const;
  capabilities: Capabilities;
  outbox: Outbound[] = [];
  #emit: ((m: Inbound) => void) | null = null;
  #silent: boolean;

  constructor(id: string, opts: { silent?: boolean } = {}) {
    this.id = id;
    this.#silent = opts.silent ?? false;
    this.capabilities = { maxTextLen: 4000, media: ['image', 'file'], typing: true };
  }

  async start(emit: (m: Inbound) => void): Promise<void> { this.#emit = emit; }

  supportsStreaming = true;

  /** 演示用流式：不真的逐字发，只是让上层能跑完流式链路 */
  async openStream(out: Omit<Outbound, 'text'>): Promise<StreamHandle> {
    return {
      update: async () => { /* 面板/对话页 靠 app.drafts 看实时文本 */ },
      end: async (text: string) => { await this.send({ ...out, text }); return true; },
      abort: async () => { /* nothing */ },
    };
  }

  async send(out: Outbound): Promise<void> {
    this.outbox.push(out);
    if (!this.#silent) console.log(`  ⟶ [${out.channel}→${out.to}] ${out.text}`);
  }

  /** 测试/演示用：模拟从该通道收到一条消息 */
  receive(partial: Omit<Inbound, 'channel' | 'chatType' | 'at'> & Partial<Pick<Inbound, 'chatType' | 'at'>>): void {
    if (!this.#emit) throw new Error(`${this.id} 未 start()`);
    this.#emit({ chatType: 'private', at: Date.now(), ...partial, channel: this.id });
  }
}
