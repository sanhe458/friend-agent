import { chatCompletion, type ChatMessage } from '../models/client.ts';
import type { ModelRegistry } from '../models/registry.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { Harness, HarnessEvent, HarnessRunOpts } from './types.ts';

/**
 * 进程内 mini-harness：用我们自己的模型 + 工具注册表跑一个工具循环。
 *
 * 它的价值：
 * - 不依赖外部装什么，永远可用（Pi 没装/挂了也能干活）
 * - 能直接用到我们自己的工具（秘塔搜索、记忆、专员），所以「深度搜索专员」靠它才真的能搜
 */
export function createLocalHarness(deps: { models: ModelRegistry; tools: ToolRegistry }): Harness {
  return {
    id: 'local',

    async available(): Promise<boolean> { return true; },

    async run(o: HarnessRunOpts): Promise<{ text: string }> {
      const provider = {
        id: o.model.providerId,
        baseUrl: o.model.baseUrl,
        apiKey: o.model.apiKey,
      };

      // 只暴露白名单里的工具；没写白名单就全给（排除记忆类，子 agent 不写别人的记忆）
      // 再排除只给前台用的（audience='reply'，MCP 工具勾了只给回复模型时，子 agent 看不到）
      const allow = o.tools && o.tools.length ? new Set(o.tools) : null;
      const usable = deps.tools.list().filter((t) => {
        if (t.audience === 'reply') return false;
        if (allow) return allow.has(t.name);
        return !t.name.startsWith('memory_');
      });

      const toolDefs = usable.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: (o.systemPrompt ? o.systemPrompt + '\n\n' : '') +
            '你是一个后台执行者。把交给你的任务做完，然后用简洁的中文汇报结果与关键发现。' +
            '需要资料就调用工具，不要编造。完成后直接给出结论，不要寒暄。',
        },
        { role: 'user', content: o.prompt },
      ];

      o.onEvent({ type: 'start' });
      let reply = '';
      const maxRounds = 8;

      for (let round = 0; round < maxRounds; round++) {
        let res;
        try {
          res = await chatCompletion({
            provider, model: o.model.model, messages,
            tools: toolDefs.length ? toolDefs : undefined,
            maxTokens: 1200,
            timeoutMs: o.timeoutMs ?? 300_000,
          });
        } catch (err) {
          const msg = (err as Error).message;
          o.onEvent({ type: 'error', message: msg });
          return { text: reply || `执行失败：${msg}` };
        }

        if (res.toolCalls.length === 0) { reply = res.text.trim(); break; }

        messages.push({ role: 'assistant', content: res.text || '', tool_calls: res.toolCalls });
        for (const tc of res.toolCalls) {
          o.onEvent({ type: 'tool', phase: 'start', name: tc.function.name, args: tc.function.arguments });
          let out: unknown;
          let isError = false;
          try {
            const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            out = await deps.tools.call(tc.function.name, parsed, {
              personId: o.ctx.personId, channel: 'subagent', chatType: 'private',
            });
          } catch (err) {
            out = { error: (err as Error).message };
            isError = true;
          }
          const s = typeof out === 'string' ? out : JSON.stringify(out);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: s.slice(0, 4000) });
          o.onEvent({ type: 'tool', phase: 'end', name: tc.function.name, result: s.slice(0, 2000), isError });
        }
      }

      // 轮数用尽还在调工具 → 逼它收口：最后一次不带工具，只要结论
      if (!reply) {
        messages.push({
          role: 'user',
          content: '停止调用工具。基于以上已经拿到的信息，直接给出最终结论（带来源），不要再请求任何工具。',
        });
        try {
          const fin = await chatCompletion({
            provider, model: o.model.model, messages, maxTokens: 1200, timeoutMs: 180_000,
          });
          reply = fin.text.trim();
        } catch (err) {
          o.onEvent({ type: 'error', message: `收口失败：${(err as Error).message}` });
        }
      }

      return { text: reply || '（子 agent 没有产出结论）' };
    },
  };
}
