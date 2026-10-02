# friend-agent

一个「朋友」的运行时 —— 不是自主任务型 agent，也不是编程 agent。
一个人格跑给所有人，每人一份独立记忆；同一个人可跨通道（QQ / Telegram）归并成一条连续会话。

技术栈：TypeScript / Node（Node ≥ 22.6，直接 `node src/index.ts` 跑 `.ts`，无需构建）。

## 跑起来

```bash
cd projects/friend-agent
node src/index.ts          # 跑一遍演示（M0/M1 全链路）
node src/index.ts --cli    # 起本地 CLI 通道，手动聊天
```

## 已完成（M0 + M1）

| 模块 | 状态 |
| --- | --- |
| `core/types.ts` | 领域类型：Person / Binding / Inbound / Outbound / Capabilities |
| `core/person.ts` | 身份解析 + 跨通道合并（验证必须在已知通道内完成） |
| `core/queue.ts` | per-person 串行队列 + **插话槽**（工具间隙消费） |
| `core/bus.ts` | 事件总线 |
| `memory/store.ts` | 内存版 person 分片记忆（recall 关键词打分） |
| `tools/registry.ts` | 工具注册表 + 超时中止（超时不预设话术） |
| `tools/builtin.ts` | time / search(桩) / memory_recall / memory_remember / delegate / task_status / list_tasks |
| `orchestrator/orchestrator.ts` | 任务分发 + 进度事件 + 假 subagent |
| `adapters/` | Adapter 接口 + MockAdapter + CliAdapter |
| `reply/engine.ts` | 前台回复引擎（**规则桩**，未接模型） |

## 待办

- **M2** 身份：验证码通道化（真正经适配器发/收验证码，而不是直接调 API）
- **M3** 前台：接快模型（替换 `reply/engine.ts` 的规则分支）+ 真搜索 + 自动召回接模型
- **M4** subagent：真任务执行（子进程 / 独立模型），结果回注走 bus
- **M5** 韧性：流式回复、并发压测、任务超时与失败重试
- 通道：接真 Telegram / QQ 适配器
- 存储：内存版 → SQLite

## 关键设计（写死在代码里的约束）

1. **回注优先级**：本条通道 ▸ `preferredChannel` ▸ 发起通道。
2. **插话**：轮次进行中用户消息进插话槽，在**下一个工具调用间隙**被取走（steering）；没有活动轮次则开新轮。
3. **delegate**：内置工具，立即返回 `{ accepted, taskId }`，不带「大概多久」这类预设话术。
4. **工具超时**：超预算即中止该工具，回复措辞由模型生成，不用模板。
5. **记忆隔离**：记忆按 personId 物理分片；前台只写 hot（短期）记忆，长期记忆交后台提炼。
