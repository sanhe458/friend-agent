import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createApp, type App } from './app.ts';
import { configPath, loadConfig, type AppConfig } from './config.ts';
import { ModelRegistry } from './models/registry.ts';
import { createMetasoSearch } from './tools/metaso.ts';

/**
 * 运行时容器：把整个 App 放在一个可整体替换的引用后面。
 *
 * - **热重载配置**：重建 App（重新读 config.local.json + 重新挂适配器），旧实例的资源释放掉
 * - **进程重启**：改代码才需要（ESM 模块缓存），拉起新进程后自己退出
 */

export const holder: { current: AppConfig } = { current: loadConfig() };
export const models = new ModelRegistry(() => holder.current);

let app: App | null = null;
let watcher: FSWatcher | null = null;
let reloadTimer: NodeJS.Timeout | null = null;

export interface ReloadInfo { at: number; reason: string; ok: boolean; note: string }

const state = {
  startedAt: Date.now(),
  lastReload: null as ReloadInfo | null,
  reloadCount: 0,
  watching: false,
  cfgMtime: 0,
};

const listeners = new Set<(next: App) => void>();

/** 订阅 App 替换事件，让持有旧引用的模块能更新 */
export function onSwap(cb: (next: App) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function build(): App {
  const cfg = holder.current;
  return createApp({
    models,
    getConfig: () => holder.current,
    search: createMetasoSearch(cfg),
  });
}

export function getApp(): App {
  if (!app) app = build();
  return app;
}

function closeOld(old: App | null): void {
  if (!old) return;
  // ⚠️ 必须先停适配器：旧实例的 Telegram 长轮询/QQ 网关不会因为对象被丢弃而自己停，
  //    每热重载一次就多一个轮询者 → 抢同一个 bot → 409 Conflict，**一条消息都收不到**。
  //    （实测：这轮我改了十几次配置，就是靠这个漏的）
  for (const a of old.adapters.all()) {
    try { a.stop?.(); } catch { /* 停不掉也不能阻止重建 */ }
  }
  try { old.sched.stop(); }
  catch { /* 定时器停不掉也不影响重建 */ }
  try { old.persist.close(); }
  catch { /* 旧句柄可能还被在跑的轮次占着，忽略 */ }
}

/** 重建 App：配置改动（含 QQ 凭据、模型、服务商、压缩策略）全部即时生效 */
export function reloadConfig(reason = 'manual'): ReloadInfo {
  const old = app;
  // ⚠️ 顺序不能反：必须**先停旧实例的适配器，再 build 新实例**。
  //    closeOld 的注释已经写明了原因（旧长轮询/网关不会自己停，会抢同一个 bot → 409），
  //    但旧代码是「先 build、后 closeOld」—— 新实例 start() 起来时旧实例还在轮询，
  //    正好制造出那段双轮询者窗口。closeOld 只依赖旧实例，提前调用完全安全。
  closeOld(old);
  holder.current = loadConfig();
  app = build();
  for (const l of listeners) {
    try { l(app); } catch { /* ignore */ }
  }

  state.reloadCount += 1;
  state.lastReload = {
    at: Date.now(), reason, ok: true,
    note: `通道 ${app.adapters.all().length} 个 · QQ ${app.qq ? '已挂载' : '未挂载'} · 工具 ${app.tools.list().length} 个`,
  };
  return state.lastReload;
}

/** 监听配置文件，改了就自动热重载（300ms 去抖，避免编辑器多次写盘触发） */
export function watchConfig(): void {
  if (watcher) return;
  const file = configPath();
  try {
    watcher = watch(file, { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        try { reloadConfig('watch'); } catch (err) {
          state.lastReload = { at: Date.now(), reason: 'watch', ok: false, note: (err as Error).message };
        }
      }, 300);
    });
    state.watching = true;
  } catch {
    // 文件还不存在等情况：退化为手动重载
    state.watching = false;
  }
}

export function stopWatch(): void {
  watcher?.close();
  watcher = null;
  state.watching = false;
}

export function runtimeInfo() {
  const file = configPath();
  let mtime = 0;
  try { if (existsSync(file)) mtime = statSync(file).mtimeMs; } catch { /* ignore */ }
  const a = getApp();
  return {
    pid: process.pid,
    uptimeMs: Date.now() - state.startedAt,
    node: process.version,
    cwd: process.cwd(),
    configFile: file,
    configMtime: mtime,
    watching: state.watching,
    reloadCount: state.reloadCount,
    lastReload: state.lastReload,
    channels: a.adapters.all().map((x) => x.id),
    /** 每个通道的真实情况：面板照实渲染，不再靠 id 猜 */
    channelInfo: a.adapters.all().map((x) => ({
      id: x.id,
      kind: x.kind ?? 'real',
      typing: typeof x.typing === 'function',
      streaming: Boolean(x.supportsStreaming),
      media: x.capabilities?.media ?? [],
      maxTextLen: x.capabilities?.maxTextLen ?? 0,
    })),
    qqMounted: Boolean(a.qq),
    tools: a.tools.list().length,
    persons: a.identity.all().length,
    runningTurns: a.identity.all().filter((p) => a.queue.isActive(p.id)).length,
  };
}

/**
 * 进程重启：拉起一个脱离父进程的新实例，然后自己退出。
 * 新实例的端口绑定会重试（见 server.ts），所以旧进程释放端口前也能起来。
 */
export function restartProcess(): { ok: boolean; note: string } {
  try {
    // 日志必须接上：否则重启后的新进程什么都看不到
    const logPath = process.env.PANEL_LOG ?? '/tmp/friend-agent-panel.log';
    let stdio: 'ignore' | ['ignore', number, number] = 'ignore';
    try {
      const fd = openSync(logPath, 'a');
      stdio = ['ignore', fd, fd];
    } catch { /* 打不开就退化为丢弃，不影响重启 */ }

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio,
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
    if (Array.isArray(stdio)) {
      // 子进程已继承 fd，父进程关掉自己的引用
      setTimeout(() => { try { closeSync(stdio[1]); } catch { /* ignore */ } }, 1000);
    }
    setTimeout(() => process.exit(0), 400);
    return { ok: true, note: `新进程已拉起（pid ${child.pid}），当前进程 0.4s 后退出` };
  } catch (err) {
    return { ok: false, note: `拉起新进程失败：${(err as Error).message}` };
  }
}
