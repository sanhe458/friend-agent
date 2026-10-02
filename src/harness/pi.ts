import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { textOf, type Harness, type HarnessEvent, type HarnessRunOpts } from './types.ts';

/** Pi 的 agent 目录；models.json 放这儿 */
const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
/** key 不落盘：models.json 里写环境变量插值，spawn 时才注入 */
const KEY_ENV = 'FRIEND_PI_KEY';

export interface PiProviderEntry { id: string; baseUrl: string; models: string[] }

/**
 * 把我们的服务商写成 Pi 的 models.json。
 * apiKey 用 `$FRIEND_PI_KEY` 插值 —— 所以这个文件里没有任何密钥。
 */
export function writePiModels(entries: PiProviderEntry[]): string {
  mkdirSync(AGENT_DIR, { recursive: true });
  const providers: Record<string, unknown> = {};
  for (const p of entries) {
    if (!p.baseUrl || p.models.length === 0) continue;
    providers[p.id] = {
      baseUrl: p.baseUrl,
      api: 'openai-completions',
      apiKey: '$' + KEY_ENV,
      models: p.models.map((id) => ({ id })),
    };
  }
  const path = join(AGENT_DIR, 'models.json');
  writeFileSync(path, JSON.stringify({ providers }, null, 2) + '\n', { mode: 0o600 });
  return path;
}

function handleRecord(rec: any, onEvent: (e: HarnessEvent) => void, state: { last: string }): void {
  switch (rec?.type) {
    case 'message_end': {
      const m = rec.message;
      if (m?.role === 'assistant') {
        const t = textOf(m.content).trim();
        if (t) state.last = t;
      }
      break;
    }
    case 'tool_execution_start':
      onEvent({ type: 'tool', phase: 'start', name: String(rec.toolName ?? '?'), args: rec.args });
      break;
    case 'tool_execution_end':
      onEvent({
        type: 'tool', phase: 'end', name: String(rec.toolName ?? '?'),
        result: textOf(rec.result).slice(0, 2000), isError: Boolean(rec.isError),
      });
      break;
    case 'compaction_end':
      onEvent({ type: 'notice', text: `Pi 上下文压缩（${rec.reason ?? '?'}）：${rec.result?.tokensBefore ?? '?'} → ${rec.result?.estimatedTokensAfter ?? '?'}` });
      break;
    case 'auto_retry_start':
      onEvent({ type: 'notice', text: `Pi 重试 ${rec.attempt}/${rec.maxAttempts}：${rec.errorMessage ?? ''}` });
      break;
    default:
      break;
  }
}

export function createPiHarness(getProviders: () => PiProviderEntry[]): Harness {
  return {
    id: 'pi',

    async available(): Promise<boolean> {
      const r = spawnSync('pi', ['--version'], { encoding: 'utf8', timeout: 20_000 });
      return r.status === 0;
    },

    async run(o: HarnessRunOpts): Promise<{ text: string }> {
      writePiModels(getProviders());
      mkdirSync(o.cwd, { recursive: true });

      const args = [
        '--mode', 'json',
        '--no-approve',       // 不信任项目本地配置
      ];
      // 会话策略：
      //   长任务专员传了 session → 用固定会话，可续跑、有历史、能自动压缩
      //   其余一律 --no-session：一次性、不留痕迹（保持不变）
      if (o.session) args.push('--session-id', o.session);
      else args.push('--no-session');
      args.push('--model', `${o.model.providerId}/${o.model.model}`);
      if (o.tools?.length) args.push('--tools', o.tools.join(','));
      if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
      args.push('--', o.prompt);

      return await new Promise<{ text: string }>((resolve) => {
        const state = { last: '' };
        const child = spawn('pi', args, {
          cwd: o.cwd,
          env: { ...process.env, [KEY_ENV]: o.model.apiKey ?? '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let buf = '';
        let stderr = '';
        let done = false;

        const finish = (err?: string) => {
          if (done) return;
          done = true;
          if (err) o.onEvent({ type: 'error', message: err });
          resolve({ text: state.last });
        };

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(`超时（${o.timeoutMs ?? 300_000}ms）`);
        }, o.timeoutMs ?? 300_000);

        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const s = line.replace(/\r$/, '').trim();
            if (!s) continue;
            try { handleRecord(JSON.parse(s), o.onEvent, state); } catch { /* 非 JSON 行忽略 */ }
          }
        });
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

        child.on('error', (e) => { clearTimeout(timer); finish(`无法启动 pi：${e.message}`); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0 && !state.last) {
            finish(`pi 退出码 ${code}${stderr ? '：' + stderr.slice(-400) : ''}`);
          } else {
            finish();
          }
        });
      });
    },
  };
}
