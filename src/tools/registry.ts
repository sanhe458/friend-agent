export interface ToolCtx {
  personId: string;
  channel: string;
  chatType: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** 默认超时：前台工具都很快，超时即中止该工具，不预设话术 */
  timeoutMs?: number;
  run: (args: any, ctx: ToolCtx) => Promise<unknown>;
  /**
   * 谁能用（三河 2026-10-02）：
   * - 不填 = 两边都能用（原有工具行为不变）
   * - 'reply' = 只给前台回复模型；'sub' = 只给子 agent
   *   （MCP 工具按服务器配置打这个标）
   */
  audience?: 'reply' | 'sub';
  /** 来源标记：MCP 工具会写服务器 id，重连时好整体摘除 */
  source?: string;
}

export class ToolTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`工具 ${name} 超过 ${ms}ms，已中止`);
    this.name = 'ToolTimeoutError';
  }
}

export class ToolRegistry {
  #tools = new Map<string, ToolDef>();

  register(tool: ToolDef): this {
    if (this.#tools.has(tool.name)) throw new Error(`工具重名: ${tool.name}`);
    this.#tools.set(tool.name, tool);
    return this;
  }

  /** 注销单个（MCP 工具随连接动态增减，必须能摘） */
  unregister(name: string): boolean { return this.#tools.delete(name); }

  /** 注销所有满足条件的（如：某台 MCP 服务器断开时摘掉它的全部工具）；返回摘了几个 */
  unregisterWhere(pred: (t: ToolDef) => boolean): number {
    let n = 0;
    for (const [name, t] of [...this.#tools]) {
      if (pred(t)) { this.#tools.delete(name); n += 1; }
    }
    return n;
  }

  has(name: string): boolean { return this.#tools.has(name); }
  get(name: string): ToolDef | undefined { return this.#tools.get(name); }
  list(): ToolDef[] { return [...this.#tools.values()]; }

  async call(name: string, args: unknown, ctx: ToolCtx): Promise<unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`未知工具: ${name}`);

    const ms = tool.timeoutMs ?? 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolTimeoutError(name, ms)), ms);
    });

    try {
      return await Promise.race([tool.run(args, ctx), guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
