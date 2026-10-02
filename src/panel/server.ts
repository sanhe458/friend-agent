import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextBudget, maskKey, saveConfig, type McpServerConfig } from '../config.ts';
import { withBuiltin } from '../reply/persona.ts';
import { fetchModelMeta } from '../models/meta.ts';
import { createMetasoSearch } from '../tools/metaso.ts';
import {
  getApp, holder, models, onSwap, reloadConfig, restartProcess, runtimeInfo, watchConfig,
} from '../runtime.ts';

// App 会被热重载整体替换：这里保持引用同步
let app = getApp();
onSwap((next) => { app = next; });

const html = readFileSync(fileURLToPath(new URL('./panel.html', import.meta.url)), 'utf8');
const chatHtml = readFileSync(fileURLToPath(new URL('./chat.html', import.meta.url)), 'utf8');

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });

/** 原始 body（签名校验必须基于未解析的原串） */
const readRaw = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', () => resolve(''));
  });


/** 面板公网可达：token 是唯一门禁 */
function authorized(req: IncomingMessage, url: URL): boolean {
  const need = holder.current.panelToken;
  if (!need) return true;
  const got = req.headers['x-panel-token'] ?? url.searchParams.get('token');
  return got === need;
}

/** 列出 OpenClaw 里可导入的服务商（只给结构，不给 key） */
function importable(): Array<{ id: string; baseUrl: string; hasKey: boolean; models: string[] }> {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8')) as any;
    const prov = raw?.models?.providers ?? raw?.providers ?? {};
    if (!prov || typeof prov !== 'object') return [];
    return Object.entries(prov).map(([id, v]) => {
      const p = (v ?? {}) as any;
      const ms = Array.isArray(p.models) ? p.models : [];
      return {
        id,
        baseUrl: String(p.baseUrl ?? p.base_url ?? ''),
        hasKey: Boolean(p.apiKey ?? p.api_key ?? p.key),
        models: ms.map((m: any) => (typeof m === 'string' ? m : String(m?.id ?? m?.name ?? ''))).filter(Boolean),
      };
    }).filter((x) => x.baseUrl);
  } catch {
    return [];
  }
}

/** 去掉 undefined/null，避免写进配置 */
const clean = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  try {
    // 页面本身不设门禁（页面里再拿 token 换 API 权限）
    /** 面板静态资源（样式 / 脚本 / 各页面模块） */
    if (req.method === 'GET' && p.startsWith('/panel/')) {
      const rel = p.slice('/panel/'.length);
      if (!rel || rel.includes('..')) return json(res, 400, { error: 'bad path' });
      try {
        const abs = fileURLToPath(new URL('./public/' + rel, import.meta.url));
        const buf = readFileSync(abs);
        const type = rel.endsWith('.css') ? 'text/css; charset=utf-8'
          : rel.endsWith('.js') ? 'application/javascript; charset=utf-8'
          : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return void res.end(buf);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && (p === '/chat' || p === '/chat.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(chatHtml);
      return;
    }

    if (p.startsWith('/api/') && !authorized(req, url)) {
      return json(res, 401, { error: 'unauthorized', needToken: true });
    }

    // ── 运行时状态 ──────────────────────────────────
    if (req.method === 'GET' && p === '/api/state') {
      const persons = app.identity.all().map((person) => ({
        id: person.id,
        displayName: person.displayName,
        bindings: person.bindings,
        preferredChannel: person.preferredChannel,
        memoryCount: app.memory.all(person.id).length,
        taskCount: app.orch.list(person.id).length,
      }));
      return json(res, 200, {
        time: Date.now(),
        counts: {
          persons: persons.length,
          tasks: app.orch.all().length,
          memories: persons.reduce((n, x) => n + x.memoryCount, 0),
          tools: app.tools.list().length,
        },
        persons,
        tools: app.tools.list().map((t) => ({ name: t.name, description: t.description, timeoutMs: t.timeoutMs })),
        log: app.log.slice(-200),
        tasks: app.orch.all(),
      });
    }

    if (req.method === 'GET' && p === '/api/chat') {
      const channel = url.searchParams.get('channel') ?? 'qq';
      const externalId = url.searchParams.get('externalId') ?? '10001';
      const person = app.identity.find(channel, externalId);
      return json(res, 200, {
        channel,
        externalId,
        person: person
          ? { id: person.id, displayName: person.displayName, bindings: person.bindings, preferredChannel: person.preferredChannel }
          : null,
        running: person ? app.queue.isActive(person.id) : false,
        draft: person ? (app.drafts.get(person.id) ?? null) : null,
        events: person ? app.engine.transcript(person.id) : [],
        memory: person ? app.memory.all(person.id).slice(-30) : [],
        tasks: person ? app.orch.list(person.id) : [],
      });
    }

    if (req.method === 'POST' && p === '/api/chat/send') {
      const b = await readBody(req);
      if (!b.text || !b.externalId) return json(res, 400, { error: '缺 text / externalId' });
      void app.say(b.channel || 'qq', String(b.externalId), String(b.text));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/memory') {
      const personId = url.searchParams.get('personId') ?? '';
      return json(res, 200, { personId, items: app.memory.all(personId) });
    }

    if (req.method === 'POST' && p === '/api/say') {
      const b = await readBody(req);
      if (!b.externalId) return json(res, 400, { error: '缺 externalId' });
      // 带 media 时走完整 inbound（用来模拟“用户发来一段语音”）；否则只当纯文本说一句
      if (Array.isArray(b.media) && b.media.length) {
        void app.inbound({
          channel: (b.channel || 'panel') as never,
          chatType: 'private',
          externalId: String(b.externalId),
          ...(b.text ? { text: String(b.text) } : {}),
          media: b.media as never,
          at: Date.now(),
        });
        return json(res, 200, { ok: true, withMedia: true });
      }
      if (!b.text) return json(res, 400, { error: '缺 text / externalId' });
      void app.say(b.channel || 'panel', String(b.externalId), String(b.text));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/search') {
      const b = await readBody(req);
      if (!b.query) return json(res, 400, { error: '缺 query' });
      const r = await createMetasoSearch(holder.current)({
        query: String(b.query),
        scope: b.scope,
        size: b.size ? Number(b.size) : undefined,
      });
      return json(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/remember') {
      const b = await readBody(req);
      if (!b.personId || !b.text) return json(res, 400, { error: '缺 personId / text' });
      app.memory.write(String(b.personId), {
        text: String(b.text), tags: ['panel'], channel: 'panel', at: Date.now(), hot: true,
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/prefer') {
      const b = await readBody(req);
      try {
        const person = app.identity.setPreferred(String(b.personId), b.channel ? String(b.channel) : undefined);
        return json(res, 200, { ok: true, person });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    /** 改人物称呼（面板与 AI 共用这一条路） */
    if (req.method === 'POST' && p === '/api/person/rename') {
      const b = await readBody(req);
      try {
        const r = app.identity.setDisplayName(String(b.personId ?? ''), String(b.name ?? ''));
        return json(res, 200, {
          ok: true,
          person: r.person,
          duplicateOf: r.duplicateOf.map((x) => ({ id: x.id, displayName: x.displayName })),
        });
      } catch (err) {
        return json(res, 200, { ok: false, error: (err as Error).message });
      }
    }

    if (req.method === 'POST' && p === '/api/merge/request') {
      const b = await readBody(req);
      try {
        app.identity.resolve(b.from.channel, b.from.externalId);
        const r = app.identity.requestMerge(b.from, b.claim);
        // ⚠️ 真的把码投递到对方对话（之前只返回码，谁都没发）
        let delivered = 'ok';
        try {
          await app.sendTo(
            r.notify.channel,
            r.notify.to,
            `【身份验证】\n验证码：${r.code}\n\n请到 ${b.from.channel} 那个对话里把上面 6 位数字回给机器人（10 分钟内有效）。`,
          );
        } catch (err) {
          delivered = (err as Error).message;
        }
        return json(res, 200, { ...r, delivered });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (req.method === 'POST' && p === '/api/merge/confirm') {
      const b = await readBody(req);
      try {
        return json(res, 200, { ok: true, person: app.identity.confirmMerge(String(b.code), b.via) });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    // ── 模型配置 ────────────────────────────────────
    if (req.method === 'GET' && p === '/api/models') {
      const c = holder.current;
      return json(res, 200, {
        providers: (c.providers ?? []).map((x) => ({
          id: x.id, label: x.label ?? '', baseUrl: x.baseUrl,
          hasKey: Boolean(x.apiKey), keyMasked: maskKey(x.apiKey),
        })),
        models: (c.models ?? []).map((m) => ({ ...m, budget: contextBudget(m.meta, c.compression) })),
        roles: c.roles ?? {},
        compression: c.compression,
        resolved: (['reply', 'main', 'sub', 'asr'] as const).map((r) => {
          // asr 走 models.asr()：没配角色时它还能退回「第一个 kind=asr 的模型」，这样显示的是**实际会用**的那个
          const hit = r === 'asr' ? models.asr() : models.resolve(r);
          return {
            role: r,
            id: r === 'asr' ? (hit?.model.id ?? '') : (c.roles?.[r] ?? ''),
            provider: hit?.provider.id ?? '',
            model: hit?.model.model ?? '',
          };
        }),
      });
    }

    if (req.method === 'GET' && p === '/api/openclaw/providers') {
      return json(res, 200, { providers: importable() });
    }

    if (req.method === 'POST' && p === '/api/providers/import') {
      const b = await readBody(req);
      const list = importable();
      const src = list.find((x) => x.id === b.providerId);
      if (!src) return json(res, 400, { error: `OpenClaw 里没有服务商 ${b.providerId}` });

      // 只搬 baseUrl + key（写进 config.local.json，0600 / gitignore）
      const raw = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8')) as any;
      const pv = (raw?.models?.providers ?? raw?.providers ?? {})[src.id] as any;
      const apiKey = String(pv?.apiKey ?? pv?.api_key ?? pv?.key ?? '');

      const c = holder.current;
      const providers = [...(c.providers ?? [])];
      const i = providers.findIndex((x) => x.id === src.id);
      const entry = { id: src.id, label: src.id, baseUrl: src.baseUrl, ...(apiKey ? { apiKey } : {}) };
      if (i >= 0) providers[i] = { ...providers[i], ...entry }; else providers.push(entry);

      const modelsList = [...(c.models ?? [])];
      for (const mid of src.models) {
        const id = `${src.id}/${mid}`;
        if (!modelsList.some((m) => m.id === id)) modelsList.push({ id, label: mid, providerId: src.id, model: mid });
      }

      holder.current = saveConfig({ providers, models: modelsList });
      return json(res, 200, { ok: true, imported: src.id, models: src.models.length, hasKey: Boolean(apiKey) });
    }

    if (req.method === 'POST' && p === '/api/providers') {
      const b = await readBody(req);
      const id = String(b.id ?? '').trim();
      const baseUrl = String(b.baseUrl ?? '').trim();
      if (!id || !baseUrl) return json(res, 400, { error: '缺 id / baseUrl' });

      const c = holder.current;
      const providers = [...(c.providers ?? [])];
      const i = providers.findIndex((x) => x.id === id);
      const apiKey = typeof b.apiKey === 'string' && b.apiKey.length > 0 ? b.apiKey : providers[i]?.apiKey;
      const entry = { id, label: String(b.label ?? providers[i]?.label ?? ''), baseUrl, apiKey };
      if (i >= 0) providers[i] = entry; else providers.push(entry);

      holder.current = saveConfig({ providers });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/providers/delete') {
      const b = await readBody(req);
      const id = String(b.id ?? '');
      const c = holder.current;
      if ((c.models ?? []).some((m) => m.providerId === id)) {
        return json(res, 400, { error: '还有模型挂在这个提供商下，先删模型' });
      }
      holder.current = saveConfig({ providers: (c.providers ?? []).filter((x) => x.id !== id) });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/models') {
      const b = await readBody(req);
      const id = String(b.id ?? '').trim();
      const providerId = String(b.providerId ?? '').trim();
      const model = String(b.model ?? '').trim();
      if (!id || !providerId || !model) return json(res, 400, { error: '缺 id / providerId / model' });
      if (!(holder.current.providers ?? []).some((x) => x.id === providerId)) {
        return json(res, 400, { error: `提供商不存在: ${providerId}` });
      }

      const c = holder.current;
      const list = [...(c.models ?? [])];
      const i = list.findIndex((m) => m.id === id);
      const prev = i >= 0 ? list[i] : undefined;
      const meta = b.meta && typeof b.meta === 'object'
        ? { ...(prev?.meta ?? {}), ...clean(b.meta), source: 'manual' }
        : prev?.meta;
      const metaUrl = b.metaUrl ? String(b.metaUrl) : prev?.metaUrl;
      const entry = {
        id,
        label: String(b.label ?? prev?.label ?? id),
        providerId,
        model,
        // 模型类型：不传就沿用原值（新模型不填 = chat）
        ...(b.kind ? { kind: String(b.kind) as never } : (prev?.kind ? { kind: prev.kind } : {})),
        ...(meta ? { meta } : {}),
        ...(metaUrl ? { metaUrl } : {}),
      };
      if (i >= 0) list[i] = entry; else list.push(entry);

      holder.current = saveConfig({ models: list });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/models/delete') {
      const b = await readBody(req);
      const id = String(b.id ?? '');
      const c = holder.current;
      const roles = { ...(c.roles ?? {}) };
      for (const k of ['reply', 'main', 'sub'] as const) if (roles[k] === id) delete roles[k];
      holder.current = saveConfig({ models: (c.models ?? []).filter((m) => m.id !== id), roles });
      return json(res, 200, { ok: true });
    }

    /** 角色/压缩现状（之前只有 POST 没有 GET，前端一直拿到 404） */
    // ── MCP：外部工具挂载（三河 2026-10-02，可勾选给谁用）──
    if (req.method === 'GET' && p === '/api/mcp') {
      const c = holder.current as Record<string, unknown>;
      return json(res, 200, {
        servers: c.mcp ?? [],
        status: app.mcp.status(),
      });
    }
    if (req.method === 'POST' && p === '/api/mcp') {
      const b = await readBody(req);
      const list = Array.isArray(b.servers) ? b.servers : [];
      const seen = new Set<string>();
      const clean: McpServerConfig[] = [];
      for (const s of list) {
        const id = String(s?.id ?? '').trim();
        const command = String(s?.command ?? '').trim();
        if (!id || !command) continue;
        if (seen.has(id)) continue; // id 重复丢弃，别静默覆盖
        seen.add(id);
        const aud = Array.isArray(s.audience)
          ? (s.audience as string[]).filter((x) => x === 'reply' || x === 'sub')
          : [];
        clean.push({
          id,
          command,
          ...(Array.isArray(s.args) && s.args.length ? { args: (s.args as unknown[]).map(String) } : {}),
          ...(s.cwd ? { cwd: String(s.cwd) } : {}),
          ...(s.enabled === false ? { enabled: false } : { enabled: true }),
          ...(aud.length ? { audience: aud as Array<'reply' | 'sub'> } : {}),
          ...(Number(s.timeoutMs) > 0 ? { timeoutMs: Number(s.timeoutMs) } : {}),
        });
      }
      holder.current = saveConfig({ mcp: clean });
      // 同步连接（新增/删除/改配置都会生效）
      await app.mcp.applyAll(clean);
      return json(res, 200, { ok: true, servers: clean, status: app.mcp.status() });
    }
    if (req.method === 'POST' && p === '/api/mcp/reconnect') {
      const b = await readBody(req);
      const id = String(b.id ?? '').trim();
      if (!id) return json(res, 400, { error: '缺 id' });
      const note = await app.mcp.reconnect(id);
      return json(res, 200, { ok: note.startsWith('✓'), note });
    }

    if (req.method === 'GET' && p === '/api/roles') {
      const c = holder.current as Record<string, unknown>;
      return json(res, 200, {
        roles: (c.roles as Record<string, string>) ?? {},
        compression: (c.compression as Record<string, unknown>) ?? {},
      });
    }

    /** Telegram：本体是长轮询，不需要公网回调 */
    if (req.method === 'GET' && p === '/api/telegram') {
      const c = holder.current as Record<string, any>;
      const t = c.telegram ?? {};
      return json(res, 200, {
        configured: Boolean(t.token),
        tokenMasked: t.token ? maskKey(String(t.token)) : '',
        pollSeconds: t.pollSeconds ?? 25,
        streaming: Boolean(t.streaming),
        allowFrom: t.allowFrom ?? [],
        adapterMounted: Boolean(app.telegram),
        status: app.telegram?.status() ?? null,
      });
    }
    if (req.method === 'POST' && p === '/api/telegram') {
      const b = await readBody(req);
      const prev = ((holder.current as Record<string, any>).telegram ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = {
        // clearToken=true 才真的清空；否则空字符串 = “不改”
        token: b.clearToken ? '' : (typeof b.token === 'string' && b.token.length > 0 ? b.token : (prev.token ?? '')),
        pollSeconds: Number(b.pollSeconds ?? prev.pollSeconds ?? 25),
        streaming: Boolean(b.streaming ?? prev.streaming ?? false),
        allowFrom: Array.isArray(b.allowFrom)
          ? (b.allowFrom as unknown[]).map(Number).filter((n) => Number.isFinite(n))
          : (prev.allowFrom ?? []),
      };
      holder.current = saveConfig({ telegram: next as never });
      reloadConfig('telegram-config');
      app = getApp();
      return json(res, 200, { ok: true, restartNeeded: false, note: '已即时生效（Telegram 通道已重新挂载）' });
    }

    /** 人格预设：列表 / 新建或修改 / 删除 / 设默认 / 指定给某个人 */
    if (req.method === 'GET' && p === '/api/personas') {
      const c = holder.current;
      return json(res, 200, {
        personas: withBuiltin(c.personas),
        defaultPersonaId: c.defaultPersonaId ?? '',
      });
    }
    if (req.method === 'POST' && p === '/api/personas') {
      const b = await readBody(req);
      const id = String(b.id ?? '').trim() || ('per_' + Math.random().toString(36).slice(2, 7));
      if (id === 'xiaoman') return json(res, 200, { ok: false, error: '内置人格不能改（可以新建议一套）' });
      const name = String(b.name ?? '').trim();
      const prompt = String(b.prompt ?? '').trim();
      if (!name || !prompt) return json(res, 200, { ok: false, error: '名字和人格正文都要填' });
      const c = holder.current;
      const list = [...(c.personas ?? [])].filter((x) => x.id !== id);
      list.push({ id, name, prompt, ...(b.greeting ? { greeting: String(b.greeting) } : {}) });
      holder.current = saveConfig({ personas: list });
      reloadConfig('personas');
      app = getApp();
      return json(res, 200, { ok: true, id });
    }
    if (req.method === 'POST' && p === '/api/personas/delete') {
      const b = await readBody(req);
      const id = String(b.id ?? '').trim();
      if (id === 'xiaoman') return json(res, 200, { ok: false, error: '内置人格不能删' });
      const c = holder.current;
      holder.current = saveConfig({
        personas: (c.personas ?? []).filter((x) => x.id !== id),
        ...(c.defaultPersonaId === id ? { defaultPersonaId: '' } : {}),
      });
      reloadConfig('personas');
      app = getApp();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/personas/default') {
      const b = await readBody(req);
      holder.current = saveConfig({ defaultPersonaId: String(b.id ?? '').trim() });
      reloadConfig('personas');
      app = getApp();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/person/set-persona') {
      const b = await readBody(req);
      try {
        const pid = String(b.personId ?? '');
        const want = String(b.personaId ?? '').trim();
        const p2 = app.identity.setPersona(pid, want || undefined);
        return json(res, 200, { ok: true, person: p2 });
      } catch (err) {
        return json(res, 200, { ok: false, error: (err as Error).message });
      }
    }

    /** 定时任务：列表 / 新建 / 删除 / 启停 / 立即执行 */
    if (req.method === 'GET' && p === '/api/jobs') {
      return json(res, 200, { jobs: app.sched.list(), now: Date.now() });
    }
    if (req.method === 'POST' && p === '/api/jobs') {
      const b = await readBody(req);
      try {
        const job = app.sched.add({
          spec: String(b.spec ?? ''),
          text: String(b.text ?? ''),
          kind: b.kind === 'ask' ? 'ask' : 'say',
          ...(b.title ? { title: String(b.title) } : {}),
          ...(b.personId ? { personId: String(b.personId) } : {}),
          channel: String(b.channel ?? 'panel'),
          to: String(b.to ?? ''),
        });
        return json(res, 200, { ok: true, job });
      } catch (err) {
        return json(res, 200, { ok: false, error: (err as Error).message });
      }
    }
    if (req.method === 'POST' && p === '/api/jobs/delete') {
      const b = await readBody(req);
      return json(res, 200, { ok: app.sched.remove(String(b.id)) });
    }
    if (req.method === 'POST' && p === '/api/jobs/toggle') {
      const b = await readBody(req);
      const j = app.sched.setEnabled(String(b.id), Boolean(b.enabled));
      return json(res, 200, j ? { ok: true, job: j } : { ok: false, error: '任务不存在' });
    }
    if (req.method === 'POST' && p === '/api/jobs/run') {
      const b = await readBody(req);
      try {
        return json(res, 200, { ok: true, result: await app.sched.runNow(String(b.id)) });
      } catch (err) {
        return json(res, 200, { ok: false, error: (err as Error).message });
      }
    }

    if (req.method === 'POST' && p === '/api/roles') {
      const b = await readBody(req);
      const roles: Record<string, string> = {};
      const bad: string[] = [];
      // ⚠️ 角色与模型类型必须对得上（三河 2026-10-02）：
      //    对话角色(reply/main/sub) 只收 chat 模型；asr 只收 kind='asr' 的模型。
      //    以前不校验，所以「对话角色」能选到 ASR 模型 —— 现在服务端也拦。
      for (const k of ['reply', 'main', 'sub', 'asr'] as const) {
        const v = String(b[k] ?? '').trim();
        if (!v) continue;
        const m = models.model(v);
        if (!m) { bad.push(`${k} → 没有模型 ${v}`); continue; }
        const want = k === 'asr' ? 'asr' : 'chat';
        const got = m.kind ?? 'chat';
        if (got !== want) {
          bad.push(`${k} 需要 ${want} 类型的模型，而「${v}」是 ${got}`);
          continue;
        }
        roles[k] = v;
      }
      if (bad.length) return json(res, 400, { error: bad.join('；') });
      holder.current = saveConfig({ roles });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/models/test') {
      const b = await readBody(req);
      if (!b.modelId) return json(res, 400, { error: '缺 modelId' });
      const m = models.model(String(b.modelId));
      if (!m) return json(res, 200, { ok: false, error: '没有这个模型' });
      const kind = m.kind ?? 'chat';
      // 非对话模型不能用 chatCompletion 测，否则报一堆看不懂的错
      if (kind !== 'chat') {
        return json(res, 200, {
          ok: true,
          ms: 0,
          note: kind === 'asr'
            ? '这是 ASR（语音转文字）模型，用对话方式测不了 —— 发一条语音给它才是真测。'
            : `这是 ${kind} 类型的模型，不能用对话方式测。`,
        });
      }
      try {
        const r = await models.test(String(b.modelId), b.prompt ? String(b.prompt) : undefined);
        return json(res, 200, r);
      } catch (err) {
        return json(res, 200, { ok: false, error: (err as Error).message });
      }
    }

    if (req.method === 'POST' && p === '/api/models/fetch-meta') {
      const b = await readBody(req);

      // 临时探测：模型还没保存时也能取（不落盘）
      if (!b.modelId && b.providerId && b.modelName) {
        const prov = models.provider(String(b.providerId));
        if (!prov) return json(res, 200, { results: [{ id: String(b.modelName), ok: false, error: '提供商不存在' }] });
        try {
          const r = await fetchModelMeta(prov, String(b.modelName), b.metaUrl ? String(b.metaUrl) : undefined);
          return json(res, 200, { results: [{ id: String(b.modelName), ok: true, from: r.from, meta: r.meta }] });
        } catch (err) {
          return json(res, 200, { results: [{ id: String(b.modelName), ok: false, error: (err as Error).message }] });
        }
      }

      const ids: string[] = b.modelId ? [String(b.modelId)] : (holder.current.models ?? []).map((m) => m.id);
      const results: unknown[] = [];

      for (const id of ids) {
        const m = models.model(id);
        if (!m) { results.push({ id, ok: false, error: '模型不存在' }); continue; }
        const prov = models.provider(m.providerId);
        if (!prov) { results.push({ id, ok: false, error: '提供商不存在' }); continue; }
        try {
          const r = await fetchModelMeta(prov, m.model, m.metaUrl);
          const list = [...(holder.current.models ?? [])];
          const i = list.findIndex((x) => x.id === id);
          if (i >= 0) list[i] = { ...list[i], meta: { ...(list[i].meta ?? {}), ...clean(r.meta as Record<string, unknown>) } };
          holder.current = saveConfig({ models: list });
          results.push({ id, ok: true, from: r.from, meta: r.meta });
        } catch (err) {
          results.push({ id, ok: false, error: (err as Error).message });
        }
      }
      return json(res, 200, { results });
    }

    if (req.method === 'POST' && p === '/api/compression') {
      const b = await readBody(req);
      const cur = holder.current.compression;
      const policy = {
        triggerRatio: Number(b.triggerRatio ?? cur.triggerRatio),
        targetRatio: Number(b.targetRatio ?? cur.targetRatio),
        keepRecentTurns: Number(b.keepRecentTurns ?? cur.keepRecentTurns),
      };
      holder.current = saveConfig({ compression: policy });
      return json(res, 200, { ok: true, compression: policy });
    }

    // ── 官方 QQ 通道 ────────────────────────────────
    if (req.method === 'GET' && p === '/api/qq') {
      const c = holder.current.qq ?? {};
      return json(res, 200, {
        configured: Boolean(c.appId && c.clientSecret),
        appId: c.appId ?? '',
        secretMasked: c.clientSecret ? maskKey(c.clientSecret) : '',
        minChars: c.minChars ?? 24,
        idleMs: c.idleMs ?? 700,
        adapterMounted: Boolean(app.qq),
        status: app.qq ? app.qq.status() : null,
      });
    }

    if (req.method === 'POST' && p === '/api/qq') {
      const b = await readBody(req);
      const prev = holder.current.qq ?? {};
      const keyName = 'client' + 'Secret';
      const raw = b[keyName];
      const prevRaw = (prev as Record<string, unknown>)[keyName];
      const next: Record<string, unknown> = {
        appId: String(b.appId ?? prev.appId ?? ''),
        minChars: Number(b.minChars ?? prev.minChars ?? 24),
        idleMs: Number(b.idleMs ?? prev.idleMs ?? 700),
        useStreaming: Boolean(b.useStreaming ?? (prev as Record<string, unknown>).useStreaming ?? false),
        gateway: Boolean(b.gateway ?? (prev as Record<string, unknown>).gateway ?? true),
      };
      next[keyName] = typeof raw === 'string' && raw.length > 0 ? raw : (prevRaw ?? '');
      holder.current = saveConfig({ qq: next as never });
      reloadConfig('qq-config');
      app = getApp();
      return json(res, 200, { ok: true, restartNeeded: false, note: '已即时生效（QQ 通道已重新挂载）' });
    }

    if (req.method === 'POST' && p === '/api/qq/check') {
      if (!app.qq) return json(res, 200, { ok: false, note: '通道未挂载（先保存 appId/clientSecret 并重启服务）' });
      return json(res, 200, await app.qq.checkAuth());
    }

    /**
     * QQ 回调（Webhook 模式）
     * op=13 地址验证 —— 回 plain_token + signature
     * 其余事件 —— 校验 Ed25519 签名 → 转 Inbound → 回 op=12 表示已收到
     */
    if (req.method === 'POST' && p === '/qq/webhook') {
      if (!app.qq) return json(res, 503, { error: 'QQ 通道未配置' });
      const raw = await readRaw(req);

      let evt: any = {};
      try { evt = raw ? JSON.parse(raw) : {}; } catch { return json(res, 200, { op: 12, d: {} }); }

      if (evt.op === 13 && evt.d?.plain_token) {
        const signature = app.qq.signValidation(String(evt.d.event_ts ?? ''), String(evt.d.plain_token));
        app.log.push({ at: Date.now(), dir: 'sys', channel: 'qq', text: '[qq] op=13 回调地址验证，已回签名' });
        return json(res, 200, { plain_token: evt.d.plain_token, signature });
      }

      const ts = String(req.headers['x-signature-timestamp'] ?? '');
      const sig = String(req.headers['x-signature-ed25519'] ?? '');
      if (!sig || !app.qq.verifyCallback(ts, raw, sig)) {
        app.log.push({ at: Date.now(), dir: 'sys', channel: 'qq', text: '[qq] 回调签名校验失败，已拒绝' });
        return json(res, 401, { op: 12, d: {} });
      }

      app.log.push({ at: Date.now(), dir: 'sys', channel: 'qq', text: `[qq] ← 回调 ${evt.t ?? '?'}` });
      const inbound = await app.qq.toInbound(evt);
      if (inbound) void app.inbound(inbound);
      return json(res, 200, { op: 12, d: {} });
    }

    // ── 运行时 & 热重载 ────────────────────────────
    if (req.method === 'GET' && p === '/api/runtime') {
      return json(res, 200, runtimeInfo());
    }

    if (req.method === 'POST' && p === '/api/reload') {
      const r = reloadConfig('panel');
      app = getApp();
      return json(res, 200, { ...r, info: runtimeInfo() });
    }

    if (req.method === 'POST' && p === '/api/restart') {
      const r = restartProcess();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r));
      return;
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: (err as Error).message });
  }
});

const port = holder.current.panelPort;
let started = false;

/** 重启时新进程会和旧进程抢端口：绑定失败就重试（旧进程退出前不会死） */
function listen(attempt = 0): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < 40) {
      setTimeout(() => listen(attempt + 1), 250);
      return;
    }
    console.error('[panel] 监听失败：', err.message);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    // 重试链路会让 listening 回调多跑一次，启动副作用只做一遍
    if (started) return;
    started = true;
    console.log(
      `[panel] http://0.0.0.0:${port}/  pid=${process.pid}` +
      `  秘塔key=${holder.current.metasoApiKey ? '有' : '无'}` +
      `  token=${holder.current.panelToken ? '已启用' : '未设'}`,
    );
    watchConfig();
  });
}
listen();
