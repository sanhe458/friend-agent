import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolRegistry, ToolDef } from '../tools/registry.ts';

/**
 * 解析命令：systemd 环境的 PATH 里没有 nvm 的 bin，裸命令（如 node）会 ENOENT。
 * 先按 PATH 找，找不到就试 node 自已所在的目录（本机 = nvm 的 bin）。
 */
function resolveCommand(command: string): string {
  if (command.includes('/') && existsSync(command)) return command;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, command))) return join(dir, command);
  }
  const alt = join(dirname(process.execPath), command);
  if (existsSync(alt)) return alt;
  return command; // 原样返回，让 spawn 报错（比静默猜测好）
}

/**
 * MCP（Model Context Protocol）客户端 —— stdio 传输。
 *
 * 把外部 MCP 服务器（子进程，JSON-RPC over stdin/stdout）的工具挂进我们的工具注册表。
 *
 * 三河 2026-10-02：可以勾选**给谁用** ——
 *   `audience: ['reply']`  只给前台回复模型
 *   `audience: ['sub']`    只给子 agent
 *   两个都勾（或都不勾）   两边都能用
 *
 * 生命周期：
 *   start()  拉起所有 enabled 的服务器、握手、拉工具表
 *   stop()   收掉所有子进程
 *   单台断了/配置改了 → 单独重启（reconnect），不影响别的
 */

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** 给谁用：'reply' / 'sub'，都勾 = 都能用。默认都给 */
  audience?: Array<'reply' | 'sub'>;
  /** 每次工具调用的超时（默认 30s） */
  timeoutMs?: number;
}

const PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC 消息类型 */
type RpcMsg = { jsonrpc: '2.0'; id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string } };

class McpConnection {
  #proc: ReturnType<typeof spawn> | null = null;
  #waits = new Map<number, (m: RpcMsg) => void>();
  /** 服务端通知（进度/日志等）。目前没有消费方，只留最近 50 条供诊断——
   *  ⚠️ 以前是无界数组：健谈的服务器（每次工具调用都推 progress）会把它撑到爆内存。 */
  #notifs: Array<{ method: string; params?: any }> = [];
  #seq = 0;
  #buf = '';
  readonly id: string;
  readonly cfg: McpServerConfig;
  lastError = '';

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
  }

  get connected(): boolean { return this.#proc !== null && this.#proc.exitCode === null; }

  async start(): Promise<void> {
    if (this.connected) return;
    this.#waits.clear();
    this.#buf = '';
    const proc = spawn(resolveCommand(this.cfg.command), this.cfg.args ?? [], {
      cwd: this.cfg.cwd ?? undefined,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#proc = proc;
    // ⚠️ spawn 失败（ENOENT 等）会发 'error' 事件 —— 不接住会把整个面板进程崩掉（实测过）
    proc.on('error', (err) => {
      this.lastError = `启动失败：${err.message}`;
      try { this.#proc = null; } catch { /* ignore */ }
    });

    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      this.#buf += chunk;
      let nl: number;
      // MCP stdio 用换行分隔的 JSON-RPC（LSP 风格的 Content-Length 头也有实现，这里按行解析，兼容两者）
      while ((nl = this.#buf.indexOf('\n')) !== -1) {
        const line = this.#buf.slice(0, nl).trim();
        this.#buf = this.#buf.slice(nl + 1);
        if (!line) continue;
        const json = line.startsWith('{') ? line : (line.replace(/^.*?(\{.*)$/s, '$1'));
        try { this.#onMsg(JSON.parse(json) as RpcMsg); } catch { /* 不是 JSON 的行（日志等）忽略 */ }
      }
    });
    proc.stderr!.on('data', (c: Buffer) => {
      const s = String(c).trim();
      if (s) this.lastError = s.slice(0, 200); // 只留最近一条，别把日志撑爆
    });
    proc.on('exit', (code) => {
      this.#proc = null;
      this.lastError = `进程退出（code ${code ?? '?'}）`;
      for (const w of this.#waits.values()) w({ jsonrpc: '2.0', error: { code: -1, message: 'MCP 服务器进程已退出' } });
      this.#waits.clear();
    });

    // 握手：initialize → initialized
    const init = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'friend-agent', version: '1.0.0' },
    }, 15_000);
    if (!init || (init as any).error) throw new Error(`initialize 失败：${JSON.stringify(init).slice(0, 200)}`);
    this.#notify('notifications/initialized');
  }

  #onMsg(m: RpcMsg): void {
    if (m.id !== undefined && this.#waits.has(Number(m.id))) {
      this.#waits.get(Number(m.id))!(m);
      this.#waits.delete(Number(m.id));
      return;
    }
    if (m.method) {
      this.#notifs.push({ method: m.method, params: (m as any).params });
      if (this.#notifs.length > 50) this.#notifs.splice(0, this.#notifs.length - 50);
    }
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<RpcMsg> {
    const id = ++this.#seq;
    return new Promise((resolve) => {
      this.#waits.set(id, resolve);
      const timer = setTimeout(() => {
        if (this.#waits.has(id)) {
          this.#waits.delete(id);
          resolve({ jsonrpc: '2.0', error: { code: -2, message: `请求超时（${timeoutMs}ms）` } });
        }
      }, timeoutMs);
      timer.unref?.();
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  #notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(obj: unknown): void {
    if (!this.#proc || this.#proc.exitCode !== null) return;
    try { this.#proc.stdin!.write(JSON.stringify(obj) + '\n'); } catch { /* 管道断了，exit 会兜 */ }
  }

  /** 列出工具（MCP tools/list） */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    const r = await this.#request('tools/list', {}, 20_000);
    const tools = (r as any)?.result?.tools;
    if (!Array.isArray(tools)) throw new Error((r as any)?.error?.message ?? 'tools/list 没返回工具表');
    return tools;
  }

  /** 调用工具（MCP tools/call） */
  async callTool(name: string, args: unknown, timeoutMs: number): Promise<{ ok: boolean; text: string; isError: boolean }> {
    const r = await this.#request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
    const res = (r as any)?.result;
    if ((r as any)?.error) return { ok: false, text: String((r as any).error.message ?? '调用失败'), isError: true };
    const content: any[] = Array.isArray(res?.content) ? res.content : [];
    const text = content
      .map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000);
    return { ok: true, text: text || '（无返回内容）', isError: Boolean(res?.isError) };
  }

  stop(): void {
    try { this.#proc?.kill(); } catch { /* ignore */ }
    this.#proc = null;
    for (const w of this.#waits.values()) w({ jsonrpc: '2.0', error: { code: -1, message: '已关闭' } });
    this.#waits.clear();
  }
}

/** 名字空间：MCP 工具名统一加前缀，避免和内置工具/别的服务器撞名 */
const prefixOf = (serverId: string) => `mcp_${serverId.replace(/[^A-Za-z0-9_-]/g, '')}_`;

export class McpManager {
  #conns = new Map<string, McpConnection>();
  #tools: ToolRegistry;
  #log: (s: string) => void;

  constructor(tools: ToolRegistry, log: (s: string) => void = () => {}) {
    this.#tools = tools;
    this.#log = log;
  }

  /** 按配置同步全部连接：新配置里没有的 → 停掉；enabled 的 → 起来并挂工具 */
  async applyAll(cfgs: McpServerConfig[]): Promise<void> {
    const want = new Map(cfgs.map((c) => [c.id, c]));

    // 摘掉配置里已经没有的
    for (const [id, conn] of [...this.#conns]) {
      if (!want.has(id)) { this.detach(id); conn.stop(); this.#conns.delete(id); }
    }

    for (const cfg of cfgs) {
      if (cfg.enabled === false) { this.detach(cfg.id); this.#conns.get(cfg.id)?.stop(); this.#conns.delete(cfg.id); continue; }
      const cur = this.#conns.get(cfg.id);
      // 配置变了（命令/参数/audience）→ 重来
      if (cur && JSON.stringify(cur.cfg) !== JSON.stringify(cfg)) {
        this.detach(cfg.id); cur.stop(); this.#conns.delete(cfg.id);
      }
      if (!this.#conns.has(cfg.id)) {
        const conn = new McpConnection(cfg);
        this.#conns.set(cfg.id, conn);
      }
      const conn = this.#conns.get(cfg.id)!;
      if (!conn.connected) {
        try {
          await conn.start();
          await this.attach(conn);
          this.#log(`[mcp] ${cfg.id} 已连接，挂载 ${await this.countTools(conn)} 个工具（audience=${JSON.stringify(cfg.audience ?? ['reply', 'sub'])}）`);
        } catch (err) {
          this.#log(`[mcp] ${cfg.id} 连接失败：${(err as Error).message}`);
        }
      }
    }
  }

  async reconnect(id: string): Promise<string> {
    const conn = this.#conns.get(id);
    if (!conn) return `没有这个 MCP 服务器：${id}`;
    this.detach(id);
    conn.stop();
    try {
      await conn.start();
      await this.attach(conn);
      return `✓ 已重连，挂载 ${await this.countTools(conn)} 个工具`;
    } catch (err) {
      return `✗ 重连失败：${(err as Error).message}`;
    }
  }

  status(): Array<{ id: string; connected: boolean; tools: number; audience: string[]; lastError?: string }> {
    return [...this.#conns.values()].map((c) => ({
      id: c.id,
      connected: c.connected,
      tools: this.listToolsOf(c.id).length,
      audience: c.cfg.audience ?? ['reply', 'sub'],
      ...(c.lastError ? { lastError: c.lastError } : {}),
    }));
  }

  stopAll(): void {
    for (const c of this.#conns.values()) c.stop();
    this.#conns.clear();
  }

  /** 把这台服务器的工具挂进注册表 */
  private async attach(conn: McpConnection): Promise<void> {
    const prefix = prefixOf(conn.id);
    // 先摘旧的（重连场景）
    this.#tools.unregisterWhere((t) => t.source === conn.id);
    const list = await conn.listTools();
    const aud = conn.cfg.audience ?? ['reply', 'sub'];
    const timeout = conn.cfg.timeoutMs ?? 30_000;
    for (const t of list) {
      const def: ToolDef = {
        name: prefix + t.name,
        description: `[MCP:${conn.id}] ${t.description ?? t.name}`,
        schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        timeoutMs: timeout,
        source: conn.id,
        ...(aud.length === 1 ? { audience: aud[0] } : {}),
        run: async (args, ctx) => {
          const r = await conn.callTool(t.name, args, timeout);
          if (r.isError) throw new Error(r.text);
          return r.text;
        },
      };
      // 撞名：先摘旧的自己这份，再挂新的（同服务器重连时会发生）
      this.#tools.unregister(def.name);
      this.#tools.register(def);
    }
  }

  private detach(serverId: string): void {
    this.#tools.unregisterWhere((t) => t.source === serverId);
  }

  private listToolsOf(serverId: string): ToolDef[] {
    return this.#tools.list().filter((t) => t.source === serverId);
  }
  private async countTools(conn: McpConnection): Promise<number> {
    return this.listToolsOf(conn.id).length;
  }
}
