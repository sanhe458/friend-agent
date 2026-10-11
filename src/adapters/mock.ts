import type { Capabilities, Inbound, Outbound } from '../core/types.ts';
import type { Adapter, StreamHandle } from './adapter.ts';
import { safeEmit } from './adapter.ts';

/** outbox 上限：静默占位通道也会收到每一条出站消息，不封顶就是一条稳定内存泄漏 */
const OUTBOX_LIMIT = 200;

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

  /** 入站投递（测试/演示用）；异常不外泄 */
  #fire(m: Inbound): void { safeEmit(this.#emit, m, (s) => { if (!this.#silent) console.log(s); }); }

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
    // 静默占位通道（panel/qq/telegram 未配时）会收到每一条出站消息，
    // outbox 又没人读 —— 以前是无限增长，现在封顶（测试只看最近几条）。
    this.outbox.push(out);
    if (this.outbox.length > OUTBOX_LIMIT) {
      this.outbox.splice(0, this.outbox.length - OUTBOX_LIMIT);
    }
    if (!this.#silent) console.log(`  ⟶ [${out.channel}→${out.to}] ${out.text}`);
  }

  /** 测试/演示用：模拟从该通道收到一条消息 */
  receive(partial: Omit<Inbound, 'channel' | 'chatType' | 'at'> & Partial<Pick<Inbound, 'chatType' | 'at'>>): void {
    if (!this.#emit) throw new Error(`${this.id} 未 start()`);
    this.#fire({ chatType: 'private', at: Date.now(), ...partial, channel: this.id });
  }
}
