import type { Adapter, StreamHandle } from './adapter.ts';
import type { Capabilities, Inbound, MediaRef, Outbound } from '../core/types.ts';

/**
 * 真正的 Telegram 适配器（Bot API）。
 *
 * 为什么它比 QQ 那套简单：
 *  - 收消息用**长轮询** getUpdates，不需要公网 HTTPS 回调、不需要证书、不需要网关长连接；
 *  - **能编辑已发出的消息**（editMessageText）→ 所以可以做到「边说边改同一条消息」的真流式，
 *    而 QQ 的流式是 replace 语义、前缀不可变更，风险大得多。
 *
 * 注意点：
 *  - 「正在输入」是 sendChatAction('typing')，**只维持约 5 秒**，所以要周期重发；
 *  - 单条消息上限 4096 字符，超了要切段；
 *  - 429 会带 retry_after，必须老实等，硬重试会被封。
 */

export interface TelegramConfig {
  token: string;
  /** 长轮询等待秒数，默认 25（Telegram 上限 50） */
  pollSeconds?: number;
  /** 只处理这些 chat id（留空 = 谁都收）。私聊 chat id 是正数，群是负数 */
  allowFrom?: number[];
  /** 流式输出（编辑同一条消息）。**默认关**：实测问题多，稳定优先 */
  streaming?: boolean;
  /** 测试时可指向本地假服务 */
  apiBase?: string;
}

export interface TelegramStatus {
  ok: boolean;
  me?: string;
  offset: number;
  updates: number;
  sent: number;
  lastError?: string;
}

const MAX_LEN = 4096;

export class TelegramAdapter implements Adapter {
  id = 'telegram';
  capabilities: Capabilities = { maxTextLen: MAX_LEN, media: ['image', 'file'], typing: true };
  /** ⚠️ 默认**关**：流式（编辑同一条消息）实测问题多，稳定优先。要开在配置里写 streaming: true */
  get supportsStreaming(): boolean { return Boolean(this.#cfg.streaming); }

  #cfg: TelegramConfig;
  #log: (s: string) => void;
  #base: string;
  /** 下载文件（语音等）用的前缀：{apiBase}/file/bot{token} */
  #fileBase: string;
  #emit: ((m: Inbound) => void) | null = null;
  #stopped = false;
  /** 是否已经在轮询（防止重复 start 造成两个轮询者） */
  #polling = false;
  /** 当前这次长轮询的取消句柄：stop() 时立即中断，不用等 25s 超时 */
  #pollAbort: AbortController | null = null;
  #offset = 0;
  #status: TelegramStatus = { ok: false, offset: 0, updates: 0, sent: 0 };
  /** 每个 chat 最近一条消息 id，用于「引用回复」 */
  #lastMsg = new Map<string, number>();

  constructor(cfg: TelegramConfig, log: (s: string) => void = () => {}) {
    this.#cfg = cfg;
    this.#log = log;
    this.#base = (cfg.apiBase ?? 'https://api.telegram.org') + '/bot' + cfg.token;
    this.#fileBase = (cfg.apiBase ?? 'https://api.telegram.org') + '/file/bot' + cfg.token;
  }

  status(): TelegramStatus { return { ...this.#status }; }

  async start(emit: (m: Inbound) => void): Promise<void> {
    if (this.#polling) {
      this.#log('[tg] 已经在轮询了，忽略重复 start（否则会与自己做 409 冲突）');
      return;
    }
    this.#polling = true;
    this.#emit = emit;
    this.#stopped = false;
    try {
      const me = await this.#call('getMe', {}, 10_000);
      const name = me?.result?.username ? '@' + me.result.username : String(me?.result?.first_name ?? 'bot');
      this.#status.ok = true;
      this.#status.me = name;
      this.#log(`[tg] 已连接 ${name}（id ${me?.result?.id}）`);
    } catch (err) {
      this.#status.ok = false;
      this.#status.lastError = (err as Error).message;
      this.#log(`[tg] 连接失败：${(err as Error).message}`);
      // 仍然继续轮询：token 可能是刚填错的，但网络恢复后能自愈
    }
    void this.#pollLoop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#polling = false;
    // 立即中断卡在长轮询里的那次请求，否则要等最多 25s 才退出
    try { this.#pollAbort?.abort(); } catch { /* ignore */ }
  }

  /* ── 底层调用 ───────────────────────────── */
  async #call(method: string, body: Record<string, unknown>, timeoutMs = 30_000, outer?: AbortSignal): Promise<any> {
    const sig = outer
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), outer])
      : AbortSignal.timeout(timeoutMs);
    const r = await fetch(`${this.#base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: sig,
    });
    const j = await r.json().catch(() => ({})) as any;
    if (!j.ok) {
      const wait = Number(j?.parameters?.retry_after ?? 0);
      const e = new Error(`Telegram ${method} 失败(${j.error_code ?? r.status})：${j.description ?? '未知'}`);
      (e as any).retryAfter = wait;
      throw e;
    }
    return j;
  }

  #allowed(chatId: string): boolean {
    const list = this.#cfg.allowFrom;
    if (!list || !list.length) return true;
    return list.includes(Number(chatId));
  }

  /* ── 收消息（长轮询）────────────────────── */
  async #pollLoop(): Promise<void> {
    const wait = Math.min(Math.max(this.#cfg.pollSeconds ?? 25, 1), 50);
    let backoff = 1000;
    while (!this.#stopped) {
      this.#pollAbort = new AbortController();
      try {
        const j = await this.#call('getUpdates', {
          offset: this.#offset,
          timeout: wait,
          allowed_updates: ['message'],
        }, (wait + 15) * 1000, this.#pollAbort.signal);

        for (const u of j.result ?? []) {
          this.#offset = Math.max(this.#offset, Number(u.update_id) + 1);
          this.#status.updates += 1;
          const m = u.message;
          if (!m) continue;
          const chatId = String(m.chat?.id ?? '');
          if (!chatId) continue;
          const text = typeof m.text === 'string' ? m.text : '';
          const voice = m.voice ?? m.audio; // voice = 语音条，audio = 音频文件
          if (!text && !voice) continue;    // 其他类型（图片等）暂不处理

          this.#lastMsg.set(chatId, Number(m.message_id));
          if (!this.#allowed(chatId)) {
            this.#log(`[tg] 忽略未授权的 chat ${chatId}`);
            continue;
          }

          // 语音 → 下载成字节，以 data URL 塞进 media（上层再做 ASR）
          let media: MediaRef[] | undefined;
          if (voice?.file_id) {
            try {
              const bytes = await this.#downloadFile(String(voice.file_id));
              const mime = String(voice.mime_type || 'audio/ogg');
              media = [{ kind: 'audio', url: `data:${mime};base64,${bytes.toString('base64')}` }];
              this.#log(`[tg] 收到语音 ${bytes.length} 字节（${mime}）`);
            } catch (err) {
              this.#log(`[tg] 语音下载失败：${(err as Error).message}`);
            }
          }

          const name = m.from?.first_name
            ? String(m.from.first_name) + (m.from.last_name ? ' ' + String(m.from.last_name) : '')
            : (m.from?.username ? '@' + m.from.username : undefined);
          this.#emit?.({
            channel: 'telegram',
            chatType: m.chat?.type === 'private' ? 'private' : 'group',
            externalId: chatId,
            ...(text ? { text } : {}),
            ...(media ? { media } : {}),
            at: Number(m.date ?? 0) * 1000 || Date.now(),
            ...(name ? { name } : {}),
          } as Inbound);
        }
        backoff = 1000;
        this.#status.ok = true;
        delete this.#status.lastError;
      } catch (err) {
        if (this.#stopped) return; // 因为 stop() 被中断，不是错
        const e = err as Error & { retryAfter?: number };
        this.#status.lastError = e.message;
        // 鉴权类错误（401/404）不重试得那么勤
        const hard = /401|404|Unauthorized|not found/.test(e.message);
        const sleep = e.retryAfter ? e.retryAfter * 1000 : (hard ? 60_000 : Math.min(backoff, 30_000));
        this.#log(`[tg] 轮询出错，${Math.round(sleep / 1000)}s 后重试：${e.message}`);
        await new Promise((r) => setTimeout(r, sleep));
        if (!hard && !e.retryAfter) backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** 下载通道里的文件（语音等） */
  async #downloadFile(fileId: string): Promise<Buffer> {
    const f = await this.#call('getFile', { file_id: fileId }, 20_000);
    const p = f?.result?.file_path;
    if (!p) throw new Error('拿不到 file_path');
    const r = await fetch(`${this.#fileBase}/${p}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`下载失败(${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }

  /* ── 发消息 ─────────────────────────────── */
  #chunks(text: string): string[] {
    if (text.length <= MAX_LEN) return [text];
    const out: string[] = [];
    let rest = text;
    while (rest.length > MAX_LEN) {
      let cut = rest.lastIndexOf('\n', MAX_LEN);
      if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
  }

  async send(out: Outbound): Promise<void> {
    const parts = this.#chunks(out.text ?? '');
    for (let i = 0; i < parts.length; i++) {
      const body: Record<string, unknown> = { chat_id: out.to, text: parts[i] };
      // 第一段引用对方的原消息，读起来更顺
      if (i === 0) {
        const mid = this.#lastMsg.get(out.to);
        if (mid) body.reply_to_message_id = mid;
      }
      try {
        await this.#call('sendMessage', body);
      } catch (err) {
        const e = err as Error & { retryAfter?: number };
        // 引用的原消息被删了 → 去掉引用重发一次
        if (/reply|quote/i.test(e.message) && body.reply_to_message_id) {
          delete body.reply_to_message_id;
          await this.#call('sendMessage', body);
        } else if (e.retryAfter) {
          // ⚠️ 限流（429）：以前直接抛错 —— **这条回复就静默丢了**。
          //    Telegram 的 429 会带 retry_after，老实等完再发一次（硬撞才会被封）。
          this.#log(`[tg] 限流，等 ${e.retryAfter}s 后重发这一段`);
          await new Promise((r) => setTimeout(r, e.retryAfter! * 1000 + 200));
          await this.#call('sendMessage', body);
        } else {
          throw err;
        }
      }
      this.#status.sent += 1;
    }
  }

  /** 「正在输入」：Telegram 的 typing 状态只维持约 5s，所以 4s 重发一次 */
  async typing(out: Omit<Outbound, 'text'>): Promise<void> {
    if (out.to.startsWith('-')) return; // 群里不发 typing（会打扰）
    await this.#call('sendChatAction', { chat_id: out.to, action: 'typing' }, 10_000);
  }
  typingKeepaliveMs = 4000;

  /* ── 真流式：先发一条，然后不断编辑它 ─────
     ⚠️ 两个坑（都踩过）：
     ① 节流不能“直接丢弃中间帧”，否则模型吐得快时全被丢掉 → 必须**尾帧补发**；
     ② 收尾不能先把 done 置位再去发，否则最终文本会被自己的守卫挡掉。 */
  async openStream(out: Omit<Outbound, 'text'>): Promise<StreamHandle | undefined> {
    const chatId = out.to;
    let messageId: number | undefined;
    let lastSent = '';
    let lastAt = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = '';
    let chain: Promise<unknown> = Promise.resolve();
    const THROTTLE = 1200; // 编辑太频繁会被限流

    /** 真正落地（发首条 / 后续编辑）。串行 + 429 退避重试一次 */
    const apply = (text: string): Promise<unknown> => {
      chain = chain.then(async () => {
        const body = text.slice(0, MAX_LEN);
        if (body === lastSent) return;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (messageId == null) {
              const r = await this.#call('sendMessage', { chat_id: chatId, text: body }, 20_000);
              messageId = Number(r?.result?.message_id);
              if (!Number.isFinite(messageId)) messageId = undefined;
              this.#status.sent += 1;
            } else {
              await this.#call('editMessageText', { chat_id: chatId, message_id: messageId, text: body }, 20_000);
            }
            lastSent = body;
            lastAt = Date.now();
            return;
          } catch (err) {
            const e = err as Error & { retryAfter?: number };
            // 「内容没变化」是正常的
            if (/message is not modified/i.test(e.message)) { lastSent = body; return; }
            if (e.retryAfter && attempt === 0) {
              await new Promise((r) => setTimeout(r, e.retryAfter! * 1000));
              continue;
            }
            this.#log(`[tg] 流式帧失败：${e.message}`);
            return;
          }
        }
      });
      return chain;
    };

    /** 带上限节流，但**不丢帧**：到点补发最后那一片 */
    const schedule = (text: string): Promise<unknown> => {
      pending = text;
      const wait = THROTTLE - (Date.now() - lastAt);
      if (wait <= 0) {
        if (timer) { clearTimeout(timer); timer = null; }
        return apply(text);
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (!done) void apply(pending);
        }, wait);
      }
      return Promise.resolve();
    };

    return {
      update: async (full) => { if (!done) await schedule(full); },
      end: async (final) => {
        if (timer) { clearTimeout(timer); timer = null; }
        done = true;
        await apply(final);            // ← 先发最终文本，再收工
        const landed = lastSent === final.slice(0, MAX_LEN);
        return messageId != null && landed; // 没落到就返回 false，调用方会补发一次
      },
      abort: async () => {
        if (timer) { clearTimeout(timer); timer = null; }
        done = true;
      },
    };
  }
}
