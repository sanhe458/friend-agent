# Zen Gate · OpenCode Zen 计划代理网关模块

小型代理网关：把 **OpenCode Zen 免费车道**封装成标准接口，
协议行为移植、并持续同步自 [zen-gate-server](https://github.com/sanhe458/zen-gate-server)（Go 版，MIT），
并**兼容 Jev 型 System One 判定模型**。

> 同步基线：zen-gate-server `main` @ `8b434ad`（2026-10-12）。
> 逐条处置见文末「与上游的同步关系」。

## 文件结构

| 文件 | 职责 | 对应上游 |
|---|---|---|
| `upstream.ts` | 协议层：会话/请求 id 铸造、指纹门（tools 四元组）、线协议路由、DSML 清洗、上游 SSE 解析、失败分类 | `lane/upstream.go` `lane/http.go` |
| `catalog.ts` | 免费车道模型目录：静态底表 + 上游实时目录（按 base id 去重、滤掉付费 id）、能力表、地区敏感标记 | `lane/catalog.go` |
| `effort.ts` | 思考力度 = 实打实的输出预算（上游忽略 `reasoning_effort`，只认 `max_tokens`） | `lane/effort.go` |
| `decode.ts` | 三线协议流解码器：块下标稳定、工具参数按 index 分槽、截断判定、checkpoint | `lane/stream.go` |
| `throttle.ts` | 限流账本：429 立刻标记、冷却到点自动失效、限额区间留档、恢复时间估算 | `lane/throttle.go` |
| `lane.ts` | 车道层：`chat()`（failover + 纯思考断流续写）、`decide()`（Jev 判定专线）、`probe()` | `lane/client.go` `lane/probe.go` |
| `gateway.ts` | HTTP 层：OpenAI / Anthropic / Responses 兼容 `/v1/*` + `/v1/systemone` + Key 护栏 | `server/*.go` |
| `index.ts` | 公共出口 | — |

## 独立网关进程

```bash
npm run zen-gate                      # 默认 127.0.0.1:8788
npm run zen-gate-test                 # 离线自测（不联网，打本地假上游）
# 自定义：node scripts/zen-gate.ts -host 0.0.0.0 -port 8788 -key ofm-xxx
```

端点：

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 模型目录：`wire`（chat/responses/messages/systemone）、`system_one`、`context_window`、`max_output`、`can_disable_thinking`、`region_sensitive`、`throttled`、`recovery_eta` |
| `GET /v1/budget?model=…` | 三档力度的实际 `max_tokens`（与真正发请求用的是同一个预算函数） |
| `POST /v1/chat/completions` | OpenAI 兼容对话；限流/模型不可用自动换模型，响应头 `x-zen-gate-served-by` = 实际服务模型 |
| `POST /v1/messages` | **Anthropic Messages**（Claude Code 一类客户端，认 `x-api-key`） |
| `POST /v1/responses` | **OpenAI Responses**（`developer` 角色会正确映射成 system） |
| `POST /v1/systemone` | Jev 判定专线：`{model, state, questions}` → `{answers}` |
| `POST /v1/probe` | 单模型体检（可用性 + 首字延迟，区分 throttled / region-blocked / unavailable） |
| `GET /healthz` | 存活探针 |

## 接入 friend-agent / 其它客户端

```json
{
  "providers": [
    { "id": "zen-gate", "label": "OpenCode Zen 网关", "baseUrl": "http://127.0.0.1:8788/v1", "apiKey": "ofm-xxx" }
  ],
  "models": [
    { "id": "zen-mimo", "providerId": "zen-gate", "model": "mimo-v2.6-flash-free" },
    { "id": "zen-jev", "providerId": "zen-gate", "model": "jev-1.13-free", "kind": "jev" }
  ],
  "roles": { "jev": "zen-jev" }
}
```

`kind: "jev"` 是本模块为 Jev 型判定模型新增的模型类型：
判定模型**不做内容生成**，只回 choice / score / noul 结构化判定，
适合当意图/情绪判定层；注册表里用 `registry.jev()` 取用，与对话角色严格分开。
chat 请求误发到 jev 模型会被车道层和网关层双重拦截（400/UpstreamError）。

## 进程内调用

```ts
import { ZenLane } from './src/zen/index.ts';
const lane = new ZenLane();

// 对话（限流自动 failover，servedBy 标注实际模型；纯思考被切断会自动续写一次）
const r = await lane.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] });
console.log(r.servedBy, r.finish, r.recovered, r.ttftMs, r.usage);

// Jev 判定
const d = await lane.decide({
  model: 'jev-1.13-free',
  state: '用户刚发来一句「烦死了」',
  questions: { is_frustrated: { type: 'choice', instructions: '用户是否在表达挫败', options: ['yes', 'no'] } },
});
```

## 协议要点（与上游逐条对齐）

- **会话铸造**：免费档配额按会话计 → 同一下游会话哈希到同一上游 `ses_*` id，每次换新 id 会立刻 429
- **指纹门**：上游指纹校验 `tools` 必须声明 `bash/glob/grep/read` 四元组；缺槽位用 pwsh 顶替（**一个 donor 只能顶一次**）或自禁用占位
- **三种线协议**：chat（默认）/ messages（union-alpha）/ responses（muse-spark）；Jev 走 systemone 专线
- **DSML 清洗**：DeepSeek v4 系偶发把内部 `<｜DSML｜…>` 控制标记当文本漏出，流式清洗（含跨片扣住）
- **限流 failover**：429 → 该模型进账本（冷却到点自动失效）→ 换下一个免费车道模型接住；地区门冷却 6 小时；
  429 之后**绝不在同一模型上重试**（配额按会话计，重试就是第二次烧额度）
- **模型点名的 401**：载荷说 `model is unavailable` 时按「模型不可用」处理，而不是报成凭据错误
- **断流**：没有终结帧 = 被切断；**只有纯思考回合**才用 checkpoint 续写一次（≤180s、输出 ≤8K、不给工具）。
  正文写一半被切直接报错 —— 半截答案不许当完整答案交给用户
- **工具参数**：一律按 index 分槽累积；参数拼不成合法 JSON → 整轮降级为 `max-tokens`，不当成功
- **Anthropic 线**：`message_stop` 不能覆盖已经收到的 `stop_reason`（否则 `max_tokens` 截断会被报成正常结束）
- **收尾帧**：chat 线的 `data: [DONE]` 就是正常收尾（上游常只发它不给 `finish_reason`）；流真的断了（既无
  `finish_reason` 也无 `[DONE]`）才算切断，按上面「断流」规则处理

## 与上游的同步关系

上游 `main` @ `8b434ad` 自 zen-gate 模块并入后的改动，逐条处置如下：

| 上游提交 | 内容 | 本模块处置 |
|---|---|---|
| `95c81719` | 会话铸造并发（nextSeq 临界区）、`jsonString(null)`、`message_stop` 覆盖 `max_tokens`、工具块随机挂载、限流账本深拷贝、出口探测超时 | **已同步**（JS 单线程没有 nextSeq 的竞态，其余逐条搬） |
| `628604f3` | `ServableModels` 兜底要排除判定模型、调用统计重复计数 | **已同步**（新增 `servable()`；本模块没有 CallRecord 统计层） |
| `e215c1fc` | 「模型点名不可用」的 401 要先于凭据分支判断；`stream` 参数透传 | **已同步** |
| `c04a6aa5` | SSE 末行无换行也要处理（否则丢终结帧/用量）；流式 `reasoning_content` 与缓冲区一致 | **已同步**（`readSSE` 由 `postStreamed` 实现；`reasoning` → `reasoning_content`） |
| `0d81d667` / `bc1e1ece` / `e2960fdd` / `f66d3f42` / `488e74ad` / `4f8dc660` / `6a749f11` | 代理池：抓取、测速、出口 IP 去重、轮换黑名单、UTC 0 点重置 | **不适用**：那是服务端为免费档按 IP 计额做的出口管理，friend-agent 是库形态、不带代理池；本模块只提供 `clearThrottle()` 供宿主换出口后清账 |
| `8b434ad0` | 出口探测测试隔离 | **不适用**（同上，无出口探测） |

> 使用免费车道仍受上游服务条款约束。
