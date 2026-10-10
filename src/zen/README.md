# Zen Gate · OpenCode Zen 计划代理网关模块

小型代理网关：把 **OpenCode Zen 免费车道**封装成标准 OpenAI 兼容接口，
协议行为移植自 [zen-gate-server](https://github.com/sanhe458/zen-gate-server)（Go 版），
并**兼容 Jev 型 System One 判定模型**。

## 文件结构

| 文件 | 职责 |
|---|---|
| `upstream.ts` | 协议层：会话/请求 id 铸造、指纹门（tools 四元组）、线协议路由、DSML 清洗、上游 SSE |
| `catalog.ts` | 免费车道模型目录（静态底表 + 上游实时目录拉取） |
| `lane.ts` | 车道层：`chat()`（429 自动 failover + 限流冷却）、`decide()`（Jev 判定专线）、`probe()` |
| `gateway.ts` | HTTP 层：OpenAI 兼容 `/v1/*` + `/v1/systemone` + API Key 护栏 |
| `index.ts` | 公共出口 |

## 独立网关进程

```bash
npm run zen-gate                      # 默认 127.0.0.1:8788
npm run zen-gate-test                 # 离线自测（不联网）
# 自定义：node scripts/zen-gate.ts -host 0.0.0.0 -port 8788 -key ofm-xxx
```

端点：

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 模型目录（jev-* 标注 `system_one: true`） |
| `POST /v1/chat/completions` | OpenAI 兼容对话；限流自动换模型，响应 `model` 字段 = 实际服务模型 |
| `POST /v1/systemone` | Jev 判定专线：`{model, state, questions}` → `{answers}` |
| `POST /v1/probe` | 单模型体检（可用性 + 延迟） |
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

// 对话（限流自动 failover，响应 servedBy 标注实际模型）
const r = await lane.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] });

// Jev 判定
const d = await lane.decide({
  model: 'jev-1.13-free',
  state: '用户刚发来一句「烦死了」',
  questions: { is_frustrated: { type: 'choice', instructions: '用户是否在表达挫败', options: ['yes', 'no'] } },
});
```

## 协议要点（移植自 Go 参考实现）

- **会话铸造**：免费档配额按会话计 → 同一下游会话哈希到同一上游 `ses_*` id，每次换新 id 会立刻 429
- **指纹门**：上游指纹校验 `tools` 必须声明 `bash/glob/grep/read` 四元组；缺槽位用 pwsh 顶替或自禁用占位
- **三种线协议**：chat（默认）/ messages（union-alpha）/ responses（muse-spark）；Jev 走 systemone 专线
- **DSML 清洗**：DeepSeek v4 系偶发把内部 `<｜DSML｜…>` 控制标记当文本漏出，流式清洗（含跨片扣住）
- **限流 failover**：429 → 该模型进 10 分钟冷却 → 换下一个免费车道模型接住；地区门冷却 6 小时

> 使用免费车道仍受上游服务条款约束。
