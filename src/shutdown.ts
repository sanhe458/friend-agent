/**
 * 进程级收尾（SIGTERM / SIGINT / exit）。
 *
 * 为什么要有它：
 *   - 以前 `app.ts` 里 `process.once('SIGTERM', mcpShutdown)` **只是杀 MCP 子进程**，
 *     而注册了 SIGTERM 监听器就等于关掉 Node 的默认退出行为 —— 面板 HTTP server、
 *     QQ 心跳 interval、Telegram 长轮询全都还挂在事件循环上，进程压根不退出。
 *     systemd `restart` 只能等超时后 SIGKILL（表现为「重启很慢/面板起不来」）。
 *   - 现在改成：各处把自己「要收的东西」登记进来，信号到了统一收，收完主动退出。
 *
 * 去重：每个模块只在模块作用域登记一次（模块本身也只会被加载一次），
 * 所以热重载（重新 createApp）不会往里堆回调。
 */

type Teardown = () => void | Promise<void>;
type LogFn = (text: string) => void;

const fns = new Set<Teardown>();
let installed = false;
let logger: LogFn | null = null;

/** 进程收尾时想留条日志（面板可以接到自己的日志流里） */
export function setShutdownLogger(fn: LogFn): void { logger = fn; }

/** 登记一个收尾动作，返回取消登记的函数 */
export function onShutdown(fn: Teardown): () => void {
  fns.add(fn);
  return () => { fns.delete(fn); };
}

/** 执行所有收尾动作；单个动作抛错不阻断其余动作 */
export async function runShutdown(reason: string): Promise<void> {
  const jobs = [...fns];
  fns.clear();
  for (const fn of jobs) {
    try { await fn(); }
    catch (err) {
      const m = (err as Error)?.message ?? String(err);
      logger?.(`[退出] 收尾动作失败：${m}`);
    }
  }
  logger?.(`[退出] ${reason} 收尾完成（${jobs.length} 项）`);
}

/** 进程退出码：让 systemd 能区分「正常退出」和「被超时杀」 */
const EXIT_CODE = 0;

/**
 * 安装信号处理（幂等）。
 * @param forceExitMs 收尾动作最多等这么久，超时就强行退出（避免某个 stop() 卡死拖住重启）
 */
export function installShutdown(forceExitMs = 8000): void {
  if (installed) return;
  installed = true;

  const bye = (sig: string) => {
    // 兜底：收尾动作卡住也不能让进程永驻
    const timer = setTimeout(() => process.exit(EXIT_CODE), forceExitMs);
    timer.unref();
    void runShutdown(`收到 ${sig}`).then(() => process.exit(EXIT_CODE));
  };

  process.once('SIGTERM', () => bye('SIGTERM'));
  process.once('SIGINT', () => bye('SIGINT'));
  // exit 里只能做同步收尾（MCP 子进程、浏览器子进程这些）
  process.once('exit', () => {
    for (const fn of fns) { try { fn(); } catch { /* 进程都要没了，别再生事 */ } }
  });

  // ⚠️ 后台承诺没人接 = Node 默认直接杀进程。
  //    对一个要 7×24 挂着收 QQ/Telegram 消息的服务来说，「一条消息发送失败」
  //    把整个进程带走是不可接受的——这里兜住并留日志，根因上的修复在各调用点。
  process.on('unhandledRejection', (reason) => {
    const m = (reason as Error)?.message ?? String(reason);
    const line = `[未处理的 Promise 拒绝] ${m.slice(0, 300)}`;
    logger?.(line);
    console.error(line);
  });
}
