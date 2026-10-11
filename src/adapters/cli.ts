import { createInterface, type Interface } from 'node:readline';
import type { Capabilities, Inbound, Outbound } from '../core/types.ts';
import type { Adapter } from './adapter.ts';

/** 本地 CLI 通道：不通 QQ/TG 也能把整条链路跑起来 */
export class CliAdapter implements Adapter {
  id = 'cli';
  capabilities: Capabilities = { maxTextLen: 100000, media: [], typing: false };
  #emit: ((m: Inbound) => void) | null = null;
  #rl: Interface | null = null;
  #externalId: string;

  constructor(externalId = 'local') { this.#externalId = externalId; }

  async start(emit: (m: Inbound) => void): Promise<void> {
    this.#emit = emit;
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    // ⚠️ 必须存住 readline 接口：不存就没有 stop() 可调，
    //    stdin 一直被引用 → 进程永远退不出去（runtime.ts / 收尾流程都只是空转）。
    this.#rl = rl;
    console.log('CLI 通道已开：输入文字回车发送（Ctrl+C 退出）');
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      this.#emit?.({
        channel: this.id,
        chatType: 'private',
        externalId: this.#externalId,
        text,
        at: Date.now(),
      });
    });
  }

  async stop(): Promise<void> {
    try { this.#rl?.close(); } catch { /* 已经关了 */ }
    this.#rl = null;
    this.#emit = null;
  }

  async send(out: Outbound): Promise<void> {
    console.log(`\n[${out.channel}] ${out.text}\n`);
  }
}
