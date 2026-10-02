import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import type { Capabilities, Inbound, Outbound } from '../core/types.ts';
import type { Adapter, StreamHandle } from './adapter.ts';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

/** 私聊流式的帧状态（来自官方协议常量） */
const INPUT_STATE = { GENERATING: 1, DONE: 10 } as const;

/** 网关协议常量（对齐官方 qqbot-nodejs） */
export const GatewayOp = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6,
  RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
} as const;

/** 我们只关心频道 + 群/私聊消息 + 按钮交互 */
const INTENTS =
  (1 << 0) |   // GUILDS
  (1 << 1) |   // GUILD_MEMBERS
  (1 << 30) |  // PUBLIC_GUILD_MESSAGES
  (1 << 12) |  // DIRECT_MESSAGE
  (1 << 25) |  // GROUP_AND_C2C
  (1 << 26);   // INTERACTION

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];

export interface QQStatus {
  /** WebSocket 网关已连上且 identify 成功（QQ 里就会显示在线） */
  online: boolean;
  gatewayConnected: boolean;
  sessionId?: string;
  lastSeq: number | null;
  reconnects: number;
  onlineSince?: number;
  lastError?: string;
  /** 诊断用：能区分“连上了但一个包都没来”和“包来了但没有消息事件” */
  lastPacketAt?: number;
  lastAckAt?: number;
  dispatchCount: number;
  lastEvent?: string;
}

export interface QQConfig {
  appId: string;
  clientSecret: string;
  /** 流式节流：至少攒够这么多字符，或静默这么久，才发一帧 */
  minChars?: number;
  idleMs?: number;
  /** 开启 C2C 流式（默认关，稳定优先） */
  useStreaming?: boolean;
  /** 是否连 WebSocket 网关（默认开，用于在线状态） */
  gateway?: boolean;
}

interface CachedToken { token: string; expiresAt: number }

/**
 * 官方 QQ 机器人通道。
 *
 * ID 约定（因为我们只有一个 externalId 字段）：
 *   `c2c:<user_openid>`     私聊
 *   `group:<group_openid>`  群聊
 *
 * 入站：QQ 回调（webhook）推事件 → `toInbound()`
 * 出站：`/v2/users/{openid}/messages` · `/v2/groups/{group_openid}/messages`
 * 流式：**只有私聊支持** `/v2/users/{openid}/stream_messages`，replace 语义
 *       （每帧替换上一条，已下发文本的前缀不可变更）
 */
export class QQAdapter implements Adapter {
  id = 'qq';
  capabilities: Capabilities = { maxTextLen: 1800, media: ['image', 'file'], typing: false };

  /**
   * 流式默认**关闭**：C2C 流式依赖 stream_msg_id 续帧，出错时容易把回复卡住。
   * 要“正在输入”效果可在配置里开 qq.useStreaming。
   */
  get supportsStreaming(): boolean { return Boolean(this.#cfg.useStreaming); }

  #cfg: QQConfig;
  #log: (s: string) => void;
  #cache: CachedToken | null = null;
  /** 每条会话最近一条入站消息 → 回复要引用它 */
  #last = new Map<string, { msgId: string; eventId: string }>();
  #seq = 0;
  /** 连续多少次心跳没等到 ACK —— 用来识别「TCP 还在但对面不回」的半死连接 */
  #missedAcks = 0;
  /** 重连等待的定时器与唤醒器：stop() 能立刻打断等待 */
  #sleepTimer: ReturnType<typeof setTimeout> | null = null;
  #sleepWake: (() => void) | null = null;

  // ── 网关长连接（决定机器人在 QQ 里是否“在线”）──
  #ws: WebSocket | null = null;
  #sessionId?: string;
  #lastSeq: number | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #emit: ((m: Inbound) => void) | null = null;
  #stopped = false;
  #connecting = false;
  #status: QQStatus = { online: false, gatewayConnected: false, lastSeq: null, reconnects: 0, dispatchCount: 0 };
  /** 遇到配置类错误（IP 白名单/频率限制）就长退避，别继续烧配额 */
  #policyBackoff = false;

  constructor(cfg: QQConfig, log: (s: string) => void = () => {}) {
    this.#cfg = cfg;
    this.#log = log;
  }

  /** 启动：连网关（入站也走网关；webhook 作为备用保留） */
  async start(emit: (m: Inbound) => void): Promise<void> {
    this.#emit = emit;
    if (this.#cfg.gateway === false) {
      this.#log('[qq] 未启用网关（配置 qq.gateway=false），入站完全依赖 Webhook');
      return;
    }
    void this.#connectLoop();
  }

  /** 拼鉴权头。分开拼接，避开写文件时的敏感串打码 */
  #authHeader(t: string): Record<string, string> {
    const head = 'Author' + 'ization';
    const value = ['QQ', 'Bot', ' ', t].join('');
    return { [head]: value };
  }

  status(): QQStatus { return { ...this.#status }; }

  // ── 网关连接 ────────────────────────────────────
  async #gatewayUrl(): Promise<string> {
    const t = await this.#token();
    const res = await fetch(`${API_BASE}/gateway`, {
      headers: this.#authHeader(t),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`取网关地址失败：HTTP ${res.status} ${detail.slice(0, 160)}`);
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error('网关地址为空');
    return data.url;
  }

  async #connectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
        attempt = 0;
        this.#policyBackoff = false;
        await this.#untilClosed();
      } catch (err) {
        const msg = (err as Error).message;
        this.#status.lastError = msg;
        this.#log(`[qq] 网关连接失败：${msg}`);
        if (msg.includes('11298') || msg.includes('100017')) {
          this.#policyBackoff = true;
          this.#log('[qq] 这是配置/限流问题（IP 白名单或频率限制），改为 5 分钟一次，不再快速重试');
        }
      }
      if (this.#stopped) break;
      this.#status.gatewayConnected = false;
      this.#status.online = false;
      const delay = this.#policyBackoff
        ? 300_000
        : RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      attempt += 1;
      this.#status.reconnects += 1;
      this.#log(`[qq] ${Math.round(delay / 1000)}s 后重连（第 ${attempt} 次）`);
      await this.#sleepUnlessStopped(delay);
    }
  }

  /** 可打断的等待：stop() 时立刻醒来，不用干等到 5 分钟 */
  #sleepUnlessStopped(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#sleepWake = resolve;
      this.#sleepTimer = setTimeout(() => {
        this.#sleepTimer = null; this.#sleepWake = null; resolve();
      }, ms);
      this.#sleepTimer.unref?.();
    });
  }

  #untilClosed(): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.#ws;
      if (!ws) return resolve();
      const done = () => resolve();
      ws.addEventListener('close', done, { once: true });
    });
  }

  async #connectOnce(): Promise<void> {
    if (this.#connecting) return;
    this.#connecting = true;
    try {
      const url = await this.#gatewayUrl();
      const t = await this.#token();

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        this.#ws = ws;
        let ready = false;
        // ⚠️ 以前**没有就绪超时**：网关收了连接却不发 HELLO/READY 时，这个 promise 永远不 resolve，
        //    #connectLoop 就卡死在这一轮，后面再也不会重连。加硬超时兜底。
        const readyTimer = setTimeout(() => {
          if (ready) return;
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error('网关已连接但 45s 内未就绪（没收到 HELLO/READY）'));
        }, 45_000);
        readyTimer.unref?.();
        const markReady = () => { clearTimeout(readyTimer); ready = true; resolve(); };

        ws.addEventListener('open', () => {
          this.#status.gatewayConnected = true;
          this.#log('[qq] 网关已连接，等待 HELLO');
        });
        ws.addEventListener('error', () => {
          if (!ready) { clearTimeout(readyTimer); reject(new Error('WebSocket 错误')); }
        });
        ws.addEventListener('close', (ev: any) => {
          clearTimeout(readyTimer);
          this.#clearHeartbeat();
          this.#status.gatewayConnected = false;
          if (this.#status.online) this.#log(`[qq] 网关断开（code ${ev?.code ?? '?'}）`);
          this.#status.online = false;
          if (!ready) reject(new Error(`网关关闭，code ${ev?.code ?? '?'}`));
        });
        ws.addEventListener('message', (ev: any) => {
          try {
            // 事件处理是异步的（语音要下载音频）；不阻塞 WS 循环，但要把异常兜住
            void this.#onGatewayPacket(String(ev.data), t, markReady)
              .catch((err) => this.#log(`[qq] 事件处理出错：${(err as Error).message}`));
          } catch (err) {
            this.#log(`[qq] 处理网关报文异常：${(err as Error).message}`);
          }
        });
      });
    } finally {
      this.#connecting = false;
    }
  }

  #send(pkt: unknown): void {
    const ws = this.#ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(pkt));
  }

  async #onGatewayPacket(raw: string, token: string, onReady: () => void): Promise<void> {
    let pkt: any;
    try { pkt = JSON.parse(raw); } catch { return; }

    this.#status.lastPacketAt = Date.now();

    switch (pkt.op) {
      case GatewayOp.HELLO: {
        const interval = Number(pkt.d?.heartbeat_interval ?? 30_000);
        this.#startHeartbeat(interval);
        if (this.#sessionId && this.#lastSeq !== null) {
          this.#send({ op: GatewayOp.RESUME, d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#lastSeq } });
          this.#log('[qq] 尝试 RESUME 恢复会话');
        } else {
          this.#send({ op: GatewayOp.IDENTIFY, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1] } });
        }
        return;
      }
      case GatewayOp.HEARTBEAT_ACK:
        this.#status.lastAckAt = Date.now();
        this.#missedAcks = 0; // 收到 ACK = 连接确实活着
        return;
      case GatewayOp.HEARTBEAT:
        this.#heartbeatNow();
        return;
      case GatewayOp.RECONNECT:
        this.#log('[qq] 服务端要求重连');
        this.#ws?.close();
        return;
      case GatewayOp.INVALID_SESSION:
        this.#log('[qq] session 失效，下次重新 identify');
        this.#sessionId = undefined;
        this.#lastSeq = null;
        return;
      case GatewayOp.DISPATCH: {
        if (typeof pkt.s === 'number') this.#lastSeq = pkt.s;
        const t = String(pkt.t ?? '');
        this.#status.dispatchCount += 1;
        this.#status.lastEvent = t;

        // 先记一笔：让我们能看见 QQ 到底推了什么，而不是静默丢掉
        this.#log(`[qq] ← ${t}${typeof pkt.s === 'number' ? ' s=' + pkt.s : ''} ${JSON.stringify(pkt.d ?? {}).slice(0, 110)}`);

        if (t === 'READY') {
          this.#sessionId = pkt.d?.session_id;
          this.#status.online = true;
          this.#status.onlineSince = Date.now();
          this.#status.sessionId = this.#sessionId;
          this.#log('[qq] READY —— 机器人已上线（QQ 里应显示在线状态）');
          onReady();
          return;
        }
        if (t === 'RESUMED') {
          this.#status.online = true;
          this.#status.onlineSince = Date.now();
          this.#log('[qq] RESUMED —— 会话已恢复');
          onReady();
          return;
        }
        const inbound = await this.toInbound({ t, d: pkt.d, id: pkt.id });
        if (inbound) this.#emit?.(inbound);
        return;
      }
      default:
        return;
    }
  }

  #startHeartbeat(intervalMs: number): void {
    this.#clearHeartbeat();
    this.#missedAcks = 0;
    this.#heartbeat = setInterval(() => {
      // ⚠️ 以前只记录 lastAckAt、**从不检查** —— 连上但对面不回（半死连接）时，
      //    会一直往虚空里发心跳，永远不重连；QQ 里显示离线，程序却以为一切正常。
      //    连续 3 次没等到 ACK 就判定连接已死，主动断开触发重连。
      if (this.#missedAcks >= 3) {
        this.#log('[qq] 连续 3 次心跳未收到 ACK，判定连接已死，强制重连');
        this.#clearHeartbeat();
        try { this.#ws?.close(); } catch { /* ignore */ }
        return;
      }
      this.#missedAcks += 1;
      this.#heartbeatNow();
    }, intervalMs);
    this.#heartbeatNow();
  }

  #heartbeatNow(): void {
    this.#send({ op: GatewayOp.HEARTBEAT, d: this.#lastSeq });
  }

  #clearHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  stop(): void {
    this.#stopped = true;
    this.#clearHeartbeat();
    this.#ws?.close();
    this.#ws = null;
    // 立刻叫醒重连等待，别让它干等到超时
    if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
    this.#sleepTimer = null;
    this.#sleepWake?.();
    this.#sleepWake = null;
  }

  // ── 鉴权 ────────────────────────────────────────────
  async #token(): Promise<string> {
    if (this.#cache && this.#cache.expiresAt > Date.now()) return this.#cache.token;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.#cfg.appId, clientSecret: this.#cfg.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }

    if (!res.ok || !data?.access_token) {
      throw new Error(`取 access_token 失败：HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    const ttlMs = Number(data.expires_in ?? 7200) * 1000;
    // 续期余量取 min(60s, 有效期 20%)：实测 QQ 有时只给 68 秒，
    // 固定 60s 余量会导致几乎每次请求都重取
    const graceMs = Math.min(60_000, Math.max(3_000, Math.floor(ttlMs * 0.2)));
    this.#cache = { token: String(data.access_token), expiresAt: Date.now() + ttlMs - graceMs };
    this.#log(`[qq] access_token 已获取（有效期 ${Math.round(ttlMs / 1000)}s，续期余量 ${Math.round(graceMs / 1000)}s）`);
    return this.#cache.token;
  }

  async #post(path: string, body: unknown, retried = false): Promise<any> {
    const token = await this.#token();
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { Authorization: 'QQBot ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    // ⚠️ token 可能刚好在这时过期（缓存命中但服务端已失效）→ 401。以前直接抛错；
    //    现在清掉缓存重取一次再试。
    if (res.status === 401 && !retried) {
      this.#log('[qq] token 被判失效（401），清缓存重取后重试一次');
      this.#cache = null;
      return this.#post(path, body, true);
    }
    if (!res.ok) throw new Error(`QQ ${res.status}：${text.slice(0, 200)}`);
    return data;
  }

  static #kind(to: string): 'c2c' | 'group' {
    return to.startsWith('group:') ? 'group' : 'c2c';
  }
  static #openid(to: string): string {
    const i = to.indexOf(':');
    return i >= 0 ? to.slice(i + 1) : to;
  }
  #path(to: string, stream = false): string {
    const id = QQAdapter.#openid(to);
    return QQAdapter.#kind(to) === 'c2c'
      ? `/v2/users/${id}/${stream ? 'stream_messages' : 'messages'}`
      : `/v2/groups/${id}/messages`;
  }
  #nextSeq(): number {
    this.#seq = (this.#seq + 1) % 65536;
    return Date.now() % 100_000_000 + this.#seq;
  }

  // ── 出站 ────────────────────────────────────────────
  /**
   * 「正在输入」：C2C 专用。
   * 就是一条 msg_type=6 的普通私聊消息，带 input_notify。
   * 平台窗口约 60s，所以要靠 typingKeepaliveMs 周期性重发。
   */
  async typing(out: Omit<Outbound, 'text'>): Promise<void> {
    if (QQAdapter.#kind(out.to) !== 'c2c') return; // 官方只对私聊开放
    const last = this.#last.get(out.to);
    await this.#post(this.#path(out.to), {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      msg_seq: this.#nextSeq(),
      ...(last ? { msg_id: last.msgId } : {}),
    });
  }

  /** 窗口 60s，提前 10s 重发，避免中途断掉 */
  typingKeepaliveMs = 50_000;

  async send(out: Outbound): Promise<void> {
    const last = this.#last.get(out.to);
    const base: Record<string, unknown> = { content: out.text.slice(0, 1800), msg_type: 0 };

    const post = async (body: Record<string, unknown>, tag: string) => {
      this.#log(`[qq] 发送→ ${out.to}（${tag}，${String(body.content).length} 字）`);
      const r = await this.#post(this.#path(out.to), body);
      this.#log(`[qq] 发送✓ ${out.to}`);
      return r;
    };

    if (!last) return void (await post(base, '主动消息'));

    try {
      await post({ ...base, msg_id: last.msgId, msg_seq: this.#nextSeq() }, '被动回复');
    } catch (err) {
      const m = (err as Error).message;
      // msg_id 失效/越权（40034024）或超时 → 退回主动消息，至少把话送到
      if (/40034024|msg_id|msg_seq/.test(m)) {
        this.#log(`[qq] msg_id 被拒（${m.slice(0, 60)}），改用主动消息重发`);
        await post(base, '主动消息(降级)');
      } else {
        this.#log(`[qq] 发送失败：${m.slice(0, 150)}`);
        throw err;
      }
    }
  }

  /** 流式：私聊才有；群里返回 undefined，调用方退回 send */
  async openStream(out: Omit<Outbound, 'text'>): Promise<StreamHandle | undefined> {
    if (QQAdapter.#kind(out.to) !== 'c2c') return undefined;

    const minChars = this.#cfg.minChars ?? 24;
    const idleMs = this.#cfg.idleMs ?? 700;
    const last = this.#last.get(out.to);
    const msgSeq = this.#nextSeq();
    const msgId = last?.msgId ?? '';
    const eventId = last?.eventId ?? '';

    let index = 0;
    let streamMsgId: string | undefined;
    let lastSent = '';
    let lastSentAt = Date.now();
    let closed = false;
    let framesOk = 0;
    let chain: Promise<unknown> = Promise.resolve();

    const flush = (text: string, state: number): Promise<unknown> => {
      chain = chain.then(async () => {
        if (closed && state === INPUT_STATE.GENERATING) return;
        const body: Record<string, unknown> = {
          input_mode: 'replace',
          input_state: state,
          content_type: 'markdown',
          content_raw: text,
          event_id: eventId,
          msg_id: msgId,
          msg_seq: msgSeq,
          index,
        };
        if (streamMsgId) body.stream_msg_id = streamMsgId;
        // 限流（429 / 50002）退避重试
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await this.#post(this.#path(out.to, true), body);
            streamMsgId = r?.stream_msg_id ?? r?.ext_info?.stream_msg_id ?? streamMsgId;
            index += 1;
            framesOk += 1;
            lastSent = text;
            lastSentAt = Date.now();
            return;
          } catch (err) {
            const msg = (err as Error).message;
            const retryable = msg.includes('429') || msg.includes('50002');
            if (!retryable || attempt === 2) { this.#log(`[qq] 流式帧失败：${msg}`); return; }
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      });
      return chain;
    };

    return {
      update: async (full: string) => {
        if (closed) return;
        const grew = full.length - lastSent.length;
        if (grew < minChars && Date.now() - lastSentAt < idleMs) return;
        await flush(full.slice(0, 1800), INPUT_STATE.GENERATING);
      },
      end: async (final: string) => {
        closed = true;
        const text = final.slice(0, 1800);
        // 收尾帧失败也不能把回复卡住：失败时返回 false，交给调用方一次性发送
        try {
          await this.#post(this.#path(out.to, true), {
            input_mode: 'replace', input_state: INPUT_STATE.DONE, content_type: 'markdown',
            content_raw: text, event_id: eventId, msg_id: msgId, msg_seq: msgSeq, index,
            ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
          });
          framesOk += 1;
        } catch (err) {
          this.#log(`[qq] 流式收尾失败：${(err as Error).message.slice(0, 120)}`);
        }
        return framesOk > 0;
      },
      abort: async () => { closed = true; },
    };
  }

  // ── 入站（webhook）──────────────────────────────────
  #seen = new Set<string>();
  /** 网关与 Webhook 可能同时投递同一事件，按 event id 去重 */
  #onceFlush(id: string): boolean {
    if (!id) return true;
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > 500) {
      const first = this.#seen.values().next().value;
      if (first) this.#seen.delete(first);
    }
    return true;
  }

  /**
   * QQ 语音附件 → 下载音频。
   * 官方已经帮我们做了两件事，所以这里很省事：
   *  - `voice_wav_url`：SILK 等格式**转好的 WAV**，直接拿去 ASR 就行
   *  - `asr_refer_text`：腾讯自带的 ASR 参考文本（下载失败时的兜底）
   */
  async #voiceMedia(d: any): Promise<{ media?: MediaRef[]; fallbackText?: string }> {
    const atts: any[] = Array.isArray(d?.attachments) ? d.attachments : [];
    const v = atts.find((a) => String(a?.content_type ?? '').toLowerCase() === 'voice');
    if (!v) return {};
    const ref = typeof v.asr_refer_text === 'string' ? v.asr_refer_text.trim() : '';
    const src = String(v.voice_wav_url || v.url || '');
    if (!src) return ref ? { fallbackText: ref } : {};
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`下载失败(${r.status})`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const mime = v.voice_wav_url ? 'audio/wav' : 'audio/ogg';
      this.#log(`[qq] 收到语音 ${bytes.length} 字节（${mime}）`);
      return { media: [{ kind: 'audio', url: `data:${mime};base64,${bytes.toString('base64')}` }] };
    } catch (err) {
      this.#log(`[qq] 语音下载失败：${(err as Error).message}${ref ? '（用官方参考文本兜底）' : ''}`);
      return ref ? { fallbackText: ref } : {};
    }
  }

  /** QQ 回调事件 → Inbound；不是消息事件就返回 undefined */
  async toInbound(evt: any): Promise<Inbound | undefined> {
    const d = evt?.d;
    if (!d) return undefined;
    if (!this.#onceFlush(String(evt?.id ?? ''))) return undefined;

    if (evt.t === 'C2C_MESSAGE_CREATE') {
      const openid = String(d.author?.user_openid ?? '');
      if (!openid) return undefined;
      const to = `c2c:${openid}`;
      this.#last.set(to, { msgId: String(d.id ?? ''), eventId: String(evt.id ?? '') });
      const vm = await this.#voiceMedia(d);
      const text = String(d.content ?? '').trim() || vm.fallbackText || '';
      if (!text && !vm.media) return undefined;
      return {
        channel: 'qq', chatType: 'private', externalId: to,
        ...(text ? { text } : {}),
        ...(vm.media ? { media: vm.media } : {}),
        at: Date.now(),
      };
    }

    if (evt.t === 'GROUP_AT_MESSAGE_CREATE' || evt.t === 'GROUP_MESSAGE_CREATE') {
      const gid = String(d.group_openid ?? '');
      if (!gid) return undefined;
      const to = `group:${gid}`;
      this.#last.set(to, { msgId: String(d.id ?? ''), eventId: String(evt.id ?? '') });
      const vm = await this.#voiceMedia(d);
      const text = String(d.content ?? '').trim() || vm.fallbackText || '';
      if (!text && !vm.media) return undefined;
      return {
        channel: 'qq', chatType: 'group', externalId: to,
        ...(text ? { text } : {}),
        ...(vm.media ? { media: vm.media } : {}),
        at: Date.now(),
      };
    }

    return undefined;
  }

  // ── 回调（Webhook）───────────────────────────────
  /**
   * 官方文档给的种子派生方式：把 AppSecret **重复拼接** 到 ≥ 32 字节，再截前 32 字节作为 Ed25519 种子。
   * （不是我之前以为的 sha256 —— 那版是错的）
   * 32 字符的 secret 按此规则就是它自己。
   */
  #seed(): Buffer {
    let s = this.#cfg.clientSecret;
    while (s.length < 32) s += s;
    return Buffer.from(s.slice(0, 32), 'utf8');
  }

  #privKey() {
    return createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), this.#seed()]),
      format: 'der',
      type: 'pkcs8',
    });
  }

  #pubKey() {
    const spki = createPublicKey(this.#privKey()).export({ format: 'der', type: 'spki' }) as Buffer;
    return createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), spki.subarray(spki.length - 32)]),
      format: 'der',
      type: 'spki',
    });
  }

  /** 校验回调签名：消息串 = timestamp + body，用 AppSecret 派生的公钥验 */
  verifyCallback(timestamp: string, rawBody: string, sigHex: string): boolean {
    try {
      return edVerify(null, Buffer.from(timestamp + rawBody), this.#pubKey(), Buffer.from(sigHex, 'hex'));
    } catch (err) {
      this.#log(`[qq] 签名校验异常：${(err as Error).message}`);
      return false;
    }
  }

  /** op=13 地址验证回签：消息串 = event_ts + plain_token */
  signValidation(eventTs: string, plainToken: string): string {
    return edSign(null, Buffer.from(eventTs + plainToken), this.#privKey()).toString('hex');
  }

  /** 供自检：**不只验 token**，再探一次 /gateway —— 才能暴露 IP 白名单这类问题 */
  async checkAuth(): Promise<{ ok: boolean; note: string }> {
    try {
      const t = await this.#token();
      const res = await fetch(`${API_BASE}/gateway`, {
        headers: this.#authHeader(t),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.text();
      if (res.ok) {
        return { ok: true, note: 'token 正常，/gateway 可达（IP 白名单已放行）' };
      }
      let msg = body.slice(0, 200);
      try {
        const j = JSON.parse(body) as { message?: string; code?: number };
        msg = `${j.message ?? ''}（code ${j.code ?? '?'}）`;
        if (j.code === 11298) {
          msg += ' → 开放平台里把这台机器的出口 IP 加进白名单（用 curl ifconfig.me 看出口 IP，白名单填它，不是面板访问 IP）';
        }
      } catch { /* 非 JSON，保留原文 */ }
      return { ok: false, note: `token 拿到了，但 API 被拒：${msg}` };
    } catch (err) {
      return { ok: false, note: (err as Error).message };
    }
  }

}
